//! Thin shell-out wrappers around `git worktree` and a couple of related git
//! read-only ops. We shell out (instead of using `git2`) for mutation because
//! it honors the user's git config, hooks, and credential helpers — the same
//! reasons a human would prefer it. Read-only diff work will still use `git2`.

use std::path::{Path, PathBuf};
use tokio::process::Command;

use crate::util::errors::{AppError, AppResult};

async fn git<I, S>(repo_root: &Path, args: I) -> AppResult<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let out = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(args)
        .output()
        .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::GitError(stderr));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// One parsed row from `git worktree list --porcelain`.
#[derive(Debug, Clone)]
pub struct WorktreeListEntry {
    pub path: PathBuf,
    pub head: String,
    pub branch: Option<String>, // "refs/heads/..." stripped to short
    pub bare: bool,
    pub detached: bool,
}

pub async fn list(repo_root: &Path) -> AppResult<Vec<WorktreeListEntry>> {
    let stdout = git(repo_root, ["worktree", "list", "--porcelain"]).await?;
    Ok(parse_porcelain(&stdout))
}

fn parse_porcelain(s: &str) -> Vec<WorktreeListEntry> {
    let mut out = Vec::new();
    let mut cur: Option<WorktreeListEntry> = None;
    for line in s.lines() {
        if line.is_empty() {
            if let Some(e) = cur.take() {
                out.push(e);
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            if let Some(e) = cur.take() {
                out.push(e);
            }
            cur = Some(WorktreeListEntry {
                path: PathBuf::from(rest),
                head: String::new(),
                branch: None,
                bare: false,
                detached: false,
            });
        } else if let Some(c) = cur.as_mut() {
            if let Some(rest) = line.strip_prefix("HEAD ") {
                c.head = rest.to_string();
            } else if let Some(rest) = line.strip_prefix("branch ") {
                c.branch = Some(
                    rest.strip_prefix("refs/heads/")
                        .unwrap_or(rest)
                        .to_string(),
                );
            } else if line == "bare" {
                c.bare = true;
            } else if line == "detached" {
                c.detached = true;
            }
        }
    }
    if let Some(e) = cur.take() {
        out.push(e);
    }
    out
}

pub async fn add(
    repo_root: &Path,
    worktree_path: &Path,
    new_branch: &str,
    base_ref: &str,
) -> AppResult<()> {
    git(
        repo_root,
        [
            "worktree".as_ref(),
            "add".as_ref(),
            "-b".as_ref(),
            new_branch.as_ref(),
            worktree_path.as_os_str(),
            base_ref.as_ref(),
        ],
    )
    .await
    .map(|_| ())
}

pub async fn remove(repo_root: &Path, worktree_path: &Path, force: bool) -> AppResult<()> {
    let mut args: Vec<&std::ffi::OsStr> = vec!["worktree".as_ref(), "remove".as_ref()];
    if force {
        args.push("--force".as_ref());
    }
    args.push(worktree_path.as_os_str());
    git(repo_root, args).await.map(|_| ())
}

pub async fn prune(repo_root: &Path) -> AppResult<()> {
    git(repo_root, ["worktree", "prune"]).await.map(|_| ())
}

/// Resolve a ref to its full commit sha (e.g. "main" -> "abc123...").
pub async fn rev_parse(repo_root: &Path, rev: &str) -> AppResult<String> {
    let stdout = git(repo_root, ["rev-parse", rev]).await?;
    Ok(stdout.trim().to_string())
}

/// `true` if the given git workdir has any staged or unstaged changes, tracked
/// or untracked.
pub async fn has_changes(repo_root: &Path) -> AppResult<bool> {
    let stdout = git(repo_root, ["status", "--porcelain"]).await?;
    Ok(!stdout.trim().is_empty())
}

/// Count of commits on `branch` not on `base` (i.e. `git rev-list base..branch --count`).
pub async fn commits_ahead(repo_root: &Path, base: &str, branch: &str) -> AppResult<u32> {
    let stdout = git(
        repo_root,
        [
            "rev-list".to_string(),
            format!("{base}..{branch}"),
            "--count".to_string(),
        ],
    )
    .await?;
    Ok(stdout.trim().parse::<u32>().unwrap_or(0))
}

/// Short name of the currently checked-out branch (e.g. "main"). Returns
/// "HEAD" if detached.
pub async fn current_branch(repo_root: &Path) -> AppResult<String> {
    let stdout = git(repo_root, ["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    Ok(stdout.trim().to_string())
}

/// Perform a non-ff merge of `branch` into the current HEAD. Returns `Ok(())`
/// on clean merge, `Err(GitError(..))` on any failure (conflict included).
pub async fn merge_no_ff(repo_root: &Path, branch: &str) -> AppResult<()> {
    git(
        repo_root,
        [
            "merge",
            "--no-ff",
            "--no-edit",
            branch,
        ],
    )
    .await
    .map(|_| ())
}

/// Abort an in-progress merge (used to roll back on conflict).
pub async fn merge_abort(repo_root: &Path) -> AppResult<()> {
    git(repo_root, ["merge", "--abort"]).await.map(|_| ())
}

/// `true` if the branch ref (e.g. "agent/foo") exists locally.
pub async fn branch_exists(repo_root: &Path, branch: &str) -> AppResult<bool> {
    let res = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .output()
        .await?;
    Ok(res.status.success())
}

/// Slugify a friendly name into a filesystem- and branch-safe segment.
/// "Add README!" -> "add-readme". Empty result falls back to "wt".
pub fn slugify(name: &str) -> String {
    let mut s = String::with_capacity(name.len());
    let mut prev_dash = true;
    for c in name.chars() {
        let ch = c.to_ascii_lowercase();
        if ch.is_ascii_alphanumeric() {
            s.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            s.push('-');
            prev_dash = true;
        }
    }
    let trimmed = s.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "wt".to_string()
    } else {
        trimmed
    }
}

/// Sibling worktrees dir: `/path/to/repo__worktrees/`.
pub fn worktrees_root_for(repo_root: &Path) -> PathBuf {
    let name = repo_root
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from("repo"));
    let mut parent = repo_root
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let mut sibling = name.clone();
    sibling.push("__worktrees");
    parent.push(sibling);
    parent
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slugify() {
        assert_eq!(slugify("Add README"), "add-readme");
        assert_eq!(slugify("fix-bug-123"), "fix-bug-123");
        assert_eq!(slugify("!!!"), "wt");
        assert_eq!(slugify("  spaces  "), "spaces");
        assert_eq!(slugify("CamelCase"), "camelcase");
    }

    #[test]
    fn test_worktrees_root_for() {
        let r = worktrees_root_for(Path::new("/Users/foo/Code/myrepo"));
        assert_eq!(r, PathBuf::from("/Users/foo/Code/myrepo__worktrees"));
    }

    #[test]
    fn test_parse_porcelain() {
        let s = "worktree /path/a\nHEAD abc123\nbranch refs/heads/main\n\nworktree /path/b\nHEAD def456\ndetached\n";
        let parsed = parse_porcelain(s);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].path, PathBuf::from("/path/a"));
        assert_eq!(parsed[0].branch.as_deref(), Some("main"));
        assert!(parsed[1].detached);
    }
}
