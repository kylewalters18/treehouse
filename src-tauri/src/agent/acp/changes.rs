//! What a turn changed in the worktree, measured from git rather than from
//! the agent's tool calls: edits made through the shell, formatters it ran,
//! and tool calls whose diffs never arrived all count, and changes from
//! earlier turns don't.
//!
//! When a turn starts (the first prompt in flight) we record the content of
//! every file git reports as changed or untracked. When the last prompt in
//! flight finishes, each file that's changed now or was then is compared
//! with its turn-start content — the snapshot, or `HEAD`'s blob for a file
//! that was clean — and the ones that differ are the turn's changes. Edits
//! the user made meanwhile count too; they happened during the turn.

use std::collections::{BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use git2::{Repository, Status, StatusOptions};
use serde::Serialize;
use ts_rs::TS;

/// Files above this are compared by hash and get no line counts.
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
/// Past this many changed-or-untracked files the snapshot is skipped (a
/// huge untracked tree); that turn gets no summary.
const MAX_FILES: usize = 5000;
/// Above this many cells the line diff counts the trimmed middle as
/// replaced (mirrors `lineDiffStats` in acp-transcript.ts).
const LCS_MAX_CELLS: usize = 1_000_000;

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TurnFileChange {
    /// Relative to the repository root (the worktree).
    pub path: String,
    /// `added`, `modified` or `deleted`.
    pub status: String,
    pub added: u32,
    pub removed: u32,
    /// Binary or too large for line counts.
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Content {
    Missing,
    Text(Vec<u8>),
    /// Too large or binary: compared by length and hash only.
    Opaque {
        len: u64,
        hash: u64,
    },
}

/// Turn-start contents of the files that were already changed.
#[derive(Debug)]
pub struct Baseline {
    root: PathBuf,
    files: HashMap<String, Content>,
}

/// Snapshot the worktree at `cwd` at the start of a turn. `None` outside a
/// git repository or when there's too much to snapshot.
pub fn snapshot(cwd: &Path) -> Option<Baseline> {
    let repo = Repository::discover(cwd).ok()?;
    let root = repo.workdir()?.to_path_buf();
    let dirty = dirty_paths(&repo)?;
    let files = dirty
        .into_iter()
        .map(|p| {
            let c = read(&root.join(&p));
            (p, c)
        })
        .collect();
    Some(Baseline { root, files })
}

/// The files that differ from `base`, sorted by path.
pub fn changes_since(base: &Baseline) -> Vec<TurnFileChange> {
    let Ok(repo) = Repository::open(&base.root) else {
        return Vec::new();
    };
    let Some(now) = dirty_paths(&repo) else {
        return Vec::new();
    };
    let candidates: BTreeSet<&String> = now.iter().chain(base.files.keys()).collect();
    let mut out = Vec::new();
    for path in candidates {
        let old = match base.files.get(path) {
            Some(c) => c.clone(),
            None => head_content(&repo, path),
        };
        let new = read(&base.root.join(path));
        if old == new {
            continue;
        }
        let status = match (&old, &new) {
            (Content::Missing, _) => "added",
            (_, Content::Missing) => "deleted",
            _ => "modified",
        };
        let (added, removed, binary) = match (&old, &new) {
            (Content::Opaque { .. }, _) | (_, Content::Opaque { .. }) => (0, 0, true),
            _ => {
                let (a, r) = line_stats(text_of(&old), text_of(&new));
                (a, r, false)
            }
        };
        out.push(TurnFileChange {
            path: path.clone(),
            status: status.into(),
            added,
            removed,
            binary,
        });
    }
    out
}

/// Paths (repo-relative, `/`-separated) git reports as changed, staged,
/// deleted or untracked, ignoring ignored files.
fn dirty_paths(repo: &Repository) -> Option<Vec<String>> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(false);
    let statuses = repo.statuses(Some(&mut opts)).ok()?;
    if statuses.len() > MAX_FILES {
        return None;
    }
    Some(
        statuses
            .iter()
            .filter(|e| e.status() != Status::CURRENT && !e.status().contains(Status::IGNORED))
            .filter_map(|e| e.path().map(str::to_string))
            .collect(),
    )
}

fn read(path: &Path) -> Content {
    match std::fs::read(path) {
        Ok(bytes) => classify(bytes),
        Err(_) => Content::Missing,
    }
}

fn head_content(repo: &Repository, path: &str) -> Content {
    let blob = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok())
        .and_then(|t| t.get_path(Path::new(path)).ok())
        .and_then(|e| e.to_object(repo).ok())
        .and_then(|o| o.into_blob().ok());
    match blob {
        Some(b) => classify(b.content().to_vec()),
        None => Content::Missing,
    }
}

fn classify(bytes: Vec<u8>) -> Content {
    let binary = bytes.iter().take(8000).any(|&b| b == 0);
    if binary || bytes.len() > MAX_TEXT_BYTES {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        bytes.hash(&mut h);
        Content::Opaque {
            len: bytes.len() as u64,
            hash: h.finish(),
        }
    } else {
        Content::Text(bytes)
    }
}

fn text_of(c: &Content) -> &[u8] {
    match c {
        Content::Text(b) => b,
        _ => &[],
    }
}

fn split_lines(s: &[u8]) -> Vec<&[u8]> {
    if s.is_empty() {
        return Vec::new();
    }
    let s = s.strip_suffix(b"\n").unwrap_or(s);
    s.split(|&b| b == b'\n').collect()
}

/// Lines added and removed from `old` to `new`: a longest-common-
/// subsequence line diff after trimming the shared head and tail.
fn line_stats(old: &[u8], new: &[u8]) -> (u32, u32) {
    let a = split_lines(old);
    let b = split_lines(new);
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let (mut end_a, mut end_b) = (a.len(), b.len());
    while end_a > start && end_b > start && a[end_a - 1] == b[end_b - 1] {
        end_a -= 1;
        end_b -= 1;
    }
    let (m, n) = (end_a - start, end_b - start);
    if m == 0 || n == 0 || m.saturating_mul(n) > LCS_MAX_CELLS {
        return (n as u32, m as u32);
    }
    let mut prev = vec![0u32; n + 1];
    let mut cur = vec![0u32; n + 1];
    for i in 1..=m {
        for j in 1..=n {
            cur[j] = if a[start + i - 1] == b[start + j - 1] {
                prev[j - 1] + 1
            } else {
                prev[j].max(cur[j - 1])
            };
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    let common = prev[n] as usize;
    ((n - common) as u32, (m - common) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempRepo;

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    /// A repo with `lib.rs` committed beside README.md; returns its path.
    fn with_tracked(repo: &TempRepo) -> String {
        write(&repo.root, "lib.rs", "fn main() {}\n");
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(&repo.root)
                .args(args)
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?}");
        };
        git(&["add", "lib.rs"]);
        git(&["commit", "-q", "-m", "lib"]);
        "lib.rs".into()
    }

    #[test]
    fn line_stats_count_changed_lines_only() {
        assert_eq!(line_stats(b"a\nb\nc\n", b"a\nX\nc\n"), (1, 1));
        assert_eq!(line_stats(b"a\nb\n", b"a\nb\nc\n"), (1, 0));
        assert_eq!(line_stats(b"", b"x\ny\n"), (2, 0));
        assert_eq!(line_stats(b"x\ny", b""), (0, 2));
    }

    #[test]
    fn reports_only_what_changed_during_the_turn() {
        let repo = TempRepo::new();
        let root = &repo.root;
        // Before the turn: README already edited, notes.txt untracked.
        write(root, "README.md", "readme\nedited before the turn\n");
        write(root, "notes.txt", "scratch\n");
        let base = snapshot(root).unwrap();

        // During the turn: a clean tracked file edited, a new file, the
        // untracked one changed, one deleted. README untouched.
        let tracked = with_tracked(&repo);
        let before = std::fs::read_to_string(root.join(&tracked)).unwrap();
        write(root, &tracked, &format!("{before}one more line\n"));
        write(root, "src/new.rs", "fn a() {}\nfn b() {}\n");
        write(root, "notes.txt", "scratch\nmore\n");

        let changes = changes_since(&base);
        let summary: Vec<_> = changes
            .iter()
            .map(|c| (c.path.as_str(), c.status.as_str(), c.added, c.removed))
            .collect();
        assert!(
            !summary.iter().any(|(p, ..)| *p == "README.md"),
            "{summary:?}"
        );
        assert!(
            summary.contains(&(tracked.as_str(), "modified", 1, 0)),
            "{summary:?}"
        );
        assert!(
            summary.contains(&("src/new.rs", "added", 2, 0)),
            "{summary:?}"
        );
        assert!(
            summary.contains(&("notes.txt", "modified", 1, 0)),
            "{summary:?}"
        );
    }

    #[test]
    fn a_deleted_file_and_a_reverted_edit() {
        let repo = TempRepo::new();
        let root = &repo.root;
        let tracked = with_tracked(&repo);
        let original = std::fs::read_to_string(root.join(&tracked)).unwrap();
        write(root, &tracked, "changed before\n");
        let base = snapshot(root).unwrap();
        // The turn puts it back exactly as committed: still a change from
        // the turn's start.
        write(root, &tracked, &original);
        let changes = changes_since(&base);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].status, "modified");

        let base = snapshot(root).unwrap();
        std::fs::remove_file(root.join(&tracked)).unwrap();
        let changes = changes_since(&base);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].status, "deleted");
    }

    #[test]
    fn no_snapshot_outside_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        assert!(snapshot(dir.path()).is_none());
    }
}
