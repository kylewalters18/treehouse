//! Commits on a worktree's branch — the History tab's list. Read-only,
//! in-process via git2 like the rest of `diff`.

use std::path::Path;

use git2::{DiffFindOptions, Repository, Sort};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::util::errors::AppResult;

use super::DiffStats;

/// Cap on listed commits. The History tab is for reviewing a branch's own
/// work, not browsing all of history; a branch this long is an outlier.
pub const MAX_COMMITS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommitSummary {
    pub sha: String,
    pub short_sha: String,
    /// First line of the message.
    pub summary: String,
    /// Full message, for tooltips.
    pub message: String,
    pub author: String,
    /// Author time, unix epoch milliseconds.
    #[ts(type = "number")]
    pub time: i64,
    /// More than one parent. The diff is against the first parent.
    pub merge: bool,
    pub stats: DiffStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BranchCommits {
    /// The base the list stops at (merge-base with the workspace base).
    pub anchor: String,
    /// Newest first.
    pub commits: Vec<CommitSummary>,
    /// More than `MAX_COMMITS` commits sit between `anchor` and HEAD.
    pub truncated: bool,
}

/// Commits reachable from HEAD but not from `anchor`, newest first.
pub fn list_commits(repo_path: &Path, anchor: &str) -> AppResult<BranchCommits> {
    let repo = Repository::open(repo_path)?;
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    walk.push_head()?;
    if let Ok(obj) = repo.revparse_single(anchor) {
        walk.hide(obj.id())?;
    }

    let mut commits = Vec::new();
    let mut truncated = false;
    for oid in walk {
        if commits.len() == MAX_COMMITS {
            truncated = true;
            break;
        }
        let commit = repo.find_commit(oid?)?;
        let tree = commit.tree()?;
        let parent_tree = commit.parents().next().map(|p| p.tree()).transpose()?;
        let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;
        let mut find = DiffFindOptions::new();
        find.renames(true);
        diff.find_similar(Some(&mut find))?;
        let s = diff.stats()?;
        let sha = commit.id().to_string();
        commits.push(CommitSummary {
            short_sha: sha[..7].to_string(),
            sha,
            summary: commit.summary().unwrap_or("").to_string(),
            message: commit.message().unwrap_or("").trim_end().to_string(),
            author: commit.author().name().unwrap_or("").to_string(),
            time: commit.author().when().seconds() * 1000,
            merge: commit.parent_count() > 1,
            stats: DiffStats {
                files_changed: s.files_changed() as u32,
                insertions: s.insertions() as u32,
                deletions: s.deletions() as u32,
            },
        });
    }

    Ok(BranchCommits {
        anchor: anchor.to_string(),
        commits,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::compute::compute_commit;
    use crate::diff::FileStatus;
    use crate::test_support::TempRepo;
    use crate::util::ids::WorktreeId;

    #[test]
    fn lists_commits_since_anchor_newest_first() {
        let r = TempRepo::new();
        let base = r.head();
        r.commit_file("a.txt", "a\n", "add a");
        r.commit_file("b.txt", "b\nb2\n", "add b");

        let h = list_commits(&r.root, &base).unwrap();
        let summaries: Vec<_> = h.commits.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(summaries, ["add b", "add a"]);
        assert_eq!(h.commits[0].stats.insertions, 2);
        assert_eq!(h.commits[0].stats.files_changed, 1);
        assert!(!h.truncated);
    }

    #[test]
    fn anchor_at_head_lists_nothing() {
        let r = TempRepo::new();
        let h = list_commits(&r.root, &r.head()).unwrap();
        assert!(h.commits.is_empty());
    }

    #[test]
    fn commit_diff_holds_only_that_commits_changes() {
        let r = TempRepo::new();
        let first = r.commit_file("a.txt", "a\n", "add a");
        let second = r.commit_file("b.txt", "b\n", "add b");
        // Uncommitted edits never leak into a commit's diff.
        r.write("a.txt", "edited\n");

        let d = compute_commit(WorktreeId::new(), &r.root, &second).unwrap();
        assert_eq!(d.base_ref, first);
        assert_eq!(d.files.len(), 1);
        assert_eq!(d.files[0].path.to_string_lossy(), "b.txt");
        assert!(matches!(d.files[0].status, FileStatus::Added));
    }

    #[test]
    fn root_commit_diffs_against_empty_tree() {
        let r = TempRepo::new();
        let d = compute_commit(WorktreeId::new(), &r.root, &r.head()).unwrap();
        assert_eq!(d.files.len(), 1);
        assert!(matches!(d.files[0].status, FileStatus::Added));
    }
}
