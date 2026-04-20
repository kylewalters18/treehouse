use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{Delta, DiffFindOptions, DiffFormat, DiffOptions, Repository};

use crate::util::errors::AppResult;
use crate::util::ids::WorktreeId;

use super::{
    DiffLine, DiffSet, DiffStats, FileDiff, FileStatus, Hunk, MAX_FILES, MAX_LINES,
};

/// Compute a fresh DiffSet for the given worktree against `base_ref`.
/// Compares the workdir (index + unstaged) against the tree at `base_ref`.
pub fn compute(
    worktree_id: WorktreeId,
    worktree_path: &Path,
    base_ref: &str,
) -> AppResult<DiffSet> {
    let repo = Repository::open(worktree_path)?;

    let base_obj = repo.revparse_single(base_ref)?;
    let base_commit = base_obj.peel_to_commit()?;
    let base_tree = base_commit.tree()?;

    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .context_lines(3)
        .interhunk_lines(1)
        .id_abbrev(8);

    // diff_tree_to_workdir (NOT ..._with_index) honors include_untracked for
    // new files the agent creates without staging. We don't need the index
    // view — agents generally don't `git add`, so "workdir vs base_ref" is
    // the right semantic.
    let mut diff = repo.diff_tree_to_workdir(Some(&base_tree), Some(&mut opts))?;

    // Detect renames / copies.
    let mut find = DiffFindOptions::new();
    find.renames(true).copies(true).rewrites(true);
    diff.find_similar(Some(&mut find))?;

    let stats = diff.stats()?;
    let files_changed = stats.files_changed();

    let computed_at = now_millis();

    if files_changed > MAX_FILES {
        return Ok(DiffSet {
            worktree_id,
            base_ref: base_ref.to_string(),
            computed_at,
            files: Vec::new(),
            stats: DiffStats {
                files_changed: files_changed as u32,
                insertions: stats.insertions() as u32,
                deletions: stats.deletions() as u32,
            },
            truncated: true,
        });
    }

    // Build per-file hunks from the print(patch) stream.
    let mut files: Vec<FileDiff> = Vec::with_capacity(files_changed);
    let mut total_insertions: u32 = 0;
    let mut total_deletions: u32 = 0;

    diff.print(DiffFormat::Patch, |delta, hunk_opt, line| {
        let new_path = delta
            .new_file()
            .path()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();

        // Ensure a FileDiff exists for this delta.
        let file_idx = match files.iter().position(|f| f.path == new_path) {
            Some(i) => i,
            None => {
                let status = map_status(delta.status(), &delta);
                let binary = is_binary(&delta);
                files.push(FileDiff {
                    path: new_path.clone(),
                    status,
                    hunks: Vec::new(),
                    binary,
                    insertions: 0,
                    deletions: 0,
                });
                files.len() - 1
            }
        };

        if let Some(h) = hunk_opt {
            let fd = &mut files[file_idx];
            let header = std::str::from_utf8(h.header()).unwrap_or("").to_string();
            let hunk_exists = fd
                .hunks
                .last()
                .map(|x| x.header == header)
                .unwrap_or(false);
            if !hunk_exists {
                fd.hunks.push(Hunk {
                    id: fnv_id(&header),
                    header: header.clone(),
                    old_start: h.old_start(),
                    old_lines: h.old_lines(),
                    new_start: h.new_start(),
                    new_lines: h.new_lines(),
                    lines: Vec::new(),
                });
            }

            // Append the line to the *current* (last) hunk.
            let origin = line.origin();
            let content = std::str::from_utf8(line.content())
                .unwrap_or("")
                .trim_end_matches('\n')
                .to_string();
            if let Some(last) = fd.hunks.last_mut() {
                match origin {
                    '+' => {
                        last.lines.push(DiffLine::Add { content });
                        fd.insertions += 1;
                        total_insertions += 1;
                    }
                    '-' => {
                        last.lines.push(DiffLine::Del { content });
                        fd.deletions += 1;
                        total_deletions += 1;
                    }
                    ' ' => last.lines.push(DiffLine::Ctx { content }),
                    _ => {}
                }
            }
        }

        // Hard stop if we've blown past the per-repo cap.
        total_insertions + total_deletions <= MAX_LINES
    })?;

    Ok(DiffSet {
        worktree_id,
        base_ref: base_ref.to_string(),
        computed_at,
        files,
        stats: DiffStats {
            files_changed: files_changed as u32,
            insertions: total_insertions,
            deletions: total_deletions,
        },
        truncated: total_insertions + total_deletions > MAX_LINES,
    })
}

fn map_status(delta_status: Delta, delta: &git2::DiffDelta<'_>) -> FileStatus {
    match delta_status {
        Delta::Added => FileStatus::Added,
        Delta::Modified => FileStatus::Modified,
        Delta::Deleted => FileStatus::Deleted,
        Delta::Untracked => FileStatus::Untracked,
        Delta::Renamed | Delta::Copied => {
            let from: PathBuf = delta
                .old_file()
                .path()
                .map(|p| p.to_path_buf())
                .unwrap_or_default();
            FileStatus::Renamed { from }
        }
        _ => FileStatus::Modified,
    }
}

fn is_binary(delta: &git2::DiffDelta<'_>) -> bool {
    delta.new_file().is_binary() || delta.old_file().is_binary()
}

fn fnv_id(s: &str) -> String {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    format!("{:x}", h.finish())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
