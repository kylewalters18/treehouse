use std::path::{Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use serde::Serialize;
use ts_rs::TS;

use crate::state::AppState;
use crate::util::errors::{AppError, AppResult};
use crate::util::ids::WorktreeId;

/// Cap the recursive file list at a number that the frontend's fuzzy
/// matcher can scan in well under one frame even on a hot path. The
/// largest open-source repos at the time of writing top out around
/// 200k files; this keeps Cmd+P responsive on those without a
/// background indexer. If a repo blows past it, the list is
/// truncated and the user sees fewer results — better than freezing.
const MAX_LIST_FILES: usize = 100_000;

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileContent {
    /// UTF-8 text if the file decodes cleanly. `None` for binary or invalid
    /// UTF-8 — the frontend renders a "binary file" placeholder in that case.
    pub text: Option<String>,
    pub size: u64,
    pub binary: bool,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TreeEntry {
    pub name: String,
    /// Worktree-relative path, forward-slash-separated on all platforms.
    pub path: String,
    pub is_dir: bool,
    /// True iff this entry is covered by `.gitignore` or the built-in ignore
    /// list — only meaningful when `list_tree` was called with
    /// `show_ignored = true`, since ignored entries are otherwise filtered
    /// out. The tree renders these dimmer so the user can tell what they're
    /// looking at.
    pub ignored: bool,
}

/// Soft cap for in-memory file reads. Larger files are still returned but
/// the frontend is expected to handle pagination (not in MVP).
const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;

/// Built-in ignores applied on top of the worktree's `.gitignore`. Same list
/// as `fs_watch::BUILTIN_IGNORES` — keep in sync.
const BUILTIN_IGNORES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".DS_Store",
    ".next",
    ".turbo",
    ".cache",
];

pub async fn read_worktree_file(
    worktree_id: WorktreeId,
    rel_path: &str,
    state: &AppState,
) -> AppResult<FileContent> {
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();

    let abs = resolve_sandboxed(&wt.path, rel_path)?;

    let meta = tokio::fs::metadata(&abs).await?;
    if !meta.is_file() {
        return Err(AppError::Unknown(format!("not a regular file: {rel_path}")));
    }
    let size = meta.len();
    if size > MAX_READ_BYTES {
        return Ok(FileContent {
            text: None,
            size,
            binary: false,
        });
    }

    let bytes = tokio::fs::read(&abs).await?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileContent {
            text: Some(text),
            size,
            binary: false,
        }),
        Err(_) => Ok(FileContent {
            text: None,
            size,
            binary: true,
        }),
    }
}

/// List one directory's direct children (used by the lazy-expanding file
/// tree). Directories come first, then files; both sorted case-insensitively.
/// `dir` is worktree-relative. "" means the worktree root.
///
/// When `show_ignored` is true, the `.gitignore` + built-in ignore filter is
/// skipped entirely and entries that *would* have been filtered come back
/// flagged `ignored = true` so the frontend can dim them.
pub async fn list_tree(
    worktree_id: WorktreeId,
    dir: &str,
    show_ignored: bool,
    state: &AppState,
) -> AppResult<Vec<TreeEntry>> {
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();

    let root = wt.path.clone();
    let sub = resolve_sandboxed(
        &root,
        if dir.is_empty() { "." } else { dir },
    )?;

    let gi = build_ignore(&root)?;
    let mut entries: Vec<TreeEntry> = Vec::new();

    let mut rd = tokio::fs::read_dir(&sub).await?;
    while let Some(entry) = rd.next_entry().await? {
        let path = entry.path();
        let ft = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            // Skip symlinks entirely for MVP — avoids cycles and surprising
            // paths outside the worktree.
            continue;
        }
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue, // non-UTF-8 filename
        };
        let ignored = is_ignored(&gi, &root, &path, ft.is_dir());
        if ignored && !show_ignored {
            continue;
        }
        let rel = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        entries.push(TreeEntry {
            name,
            path: rel,
            is_dir: ft.is_dir(),
            ignored,
        });
    }

    entries.sort_by(|a, b| {
        (!a.is_dir)
            .cmp(&!b.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Recursive flat list of all files in the worktree, gitignore- and
/// builtin-ignore-aware. Returns worktree-relative, forward-slash-
/// separated paths sorted lexicographically. Used by the Cmd+P
/// "Go to file" finder; the frontend does fuzzy matching over the
/// returned slice.
///
/// Hidden files (`.git`, `.cache`, etc.) and the patterns in
/// `BUILTIN_IGNORES` are filtered the same way `list_tree` filters
/// them so the finder doesn't surface noise like vendored deps,
/// build outputs, or platform metadata.
pub async fn list_files(
    worktree_id: WorktreeId,
    state: &AppState,
) -> AppResult<Vec<String>> {
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();
    let root = wt.path.clone();

    // `WalkBuilder` honors `.gitignore`, `.git/info/exclude`, and
    // global git excludes. We layer our `BUILTIN_IGNORES` on top via
    // a single `add_custom_ignore_filename` would be cleaner, but
    // since these are just glob patterns we feed them through a
    // separate `Gitignore` and check each entry — keeps parity with
    // `list_tree` which uses the same approach.
    let builtin = build_ignore(&root)?;

    // Walk on a blocking thread — `ignore::WalkBuilder` is sync.
    let root_for_walk = root.clone();
    let files = tokio::task::spawn_blocking(move || -> Vec<String> {
        let walker = WalkBuilder::new(&root_for_walk)
            .hidden(true)       // skip dotfiles unless re-added by .gitignore
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .build();
        let mut out: Vec<String> = Vec::new();
        for result in walker {
            if out.len() >= MAX_LIST_FILES {
                break;
            }
            let entry = match result {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            // The walker's first yield is the root itself; skip it.
            if path == root_for_walk {
                continue;
            }
            let ft = match entry.file_type() {
                Some(ft) => ft,
                None => continue,
            };
            if !ft.is_file() {
                continue;
            }
            if is_ignored(&builtin, &root_for_walk, path, false) {
                continue;
            }
            let rel = path
                .strip_prefix(&root_for_walk)
                .unwrap_or(path)
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            out.push(rel);
        }
        out.sort();
        out
    })
    .await
    .map_err(|e| AppError::Unknown(format!("list_files join: {e}")))?;

    Ok(files)
}

fn build_ignore(root: &Path) -> AppResult<Gitignore> {
    let mut builder = GitignoreBuilder::new(root);
    let _ = builder.add(root.join(".gitignore"));
    for pat in BUILTIN_IGNORES {
        let _ = builder.add_line(None, pat);
    }
    builder
        .build()
        .map_err(|e| AppError::Unknown(format!("gitignore build: {e}")))
}

fn is_ignored(gi: &Gitignore, root: &Path, path: &Path, is_dir: bool) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    gi.matched_path_or_any_parents(rel, is_dir).is_ignore()
}

/// Resolve `rel` relative to `root`, canonicalize, and reject any result that
/// escapes `root`. Prevents `../..` probes outside the worktree.
fn resolve_sandboxed(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let candidate = root.join(rel);
    let canon_root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let canon = dunce::canonicalize(&candidate)
        .map_err(|e| AppError::Io(format!("canonicalize {rel}: {e}")))?;
    if !canon.starts_with(&canon_root) {
        return Err(AppError::Unknown(format!("path escape: {rel}")));
    }
    Ok(canon)
}
