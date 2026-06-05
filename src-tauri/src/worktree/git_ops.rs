//! Thin shell-out wrappers around `git worktree` and a couple of related git
//! read-only ops. We shell out (instead of using `git2`) for mutation because
//! it honors the user's git config, hooks, and credential helpers — the same
//! reasons a human would prefer it. Read-only diff work will still use `git2`.

use std::path::{Path, PathBuf};
use tokio::process::Command;

use crate::util::errors::{AppError, AppResult};
use git2::Repository;

async fn git<I, S>(repo_root: &Path, args: I) -> AppResult<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let out = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        // Never let a git op block on an interactive credential prompt — we run
        // headless from a GUI with no controlling terminal, so a missing/expired
        // credential should fail fast (and surface as an error) rather than hang
        // forever on a prompt nothing can answer.
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(args)
        .output()
        .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::GitError(stderr));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `git remote get-url origin`. Returns `Ok(None)` when there's no `origin`
/// (a local-only repo) rather than erroring — matches `show_blob`'s convention
/// so the forge layer can treat "no remote" as "no forge."
pub async fn remote_url(repo_root: &Path) -> AppResult<Option<String>> {
    match git(repo_root, ["remote", "get-url", "origin"]).await {
        Ok(s) => {
            let s = s.trim().to_string();
            Ok((!s.is_empty()).then_some(s))
        }
        Err(_) => Ok(None),
    }
}

/// Push a branch to `origin` with upstream tracking. Used before opening an
/// MR/PR — `gh pr create` / `glab mr create` need the branch to already exist
/// on the remote. Honors the user's credential helper via the git CLI.
///
/// Bounded by a timeout so a stalled remote (or a credential setup that, despite
/// `GIT_TERMINAL_PROMPT=0`, still blocks) can't hang the caller forever. Auth
/// failures come back as a clear, actionable error rather than a spinner.
pub async fn push_branch(repo_root: &Path, branch: &str) -> AppResult<()> {
    let fut = git(repo_root, ["push", "-u", "origin", branch]);
    match tokio::time::timeout(std::time::Duration::from_secs(120), fut).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(AppError::GitError(format!(
            "couldn't push '{branch}' to origin: {e}. \
             Check your git credentials for the remote — e.g. configure glab/gh \
             as a credential helper (`git config --global \
             credential.<host>.helper '!glab auth git-credential'`)."
        ))),
        Err(_) => Err(AppError::GitError(format!(
            "pushing '{branch}' to origin timed out after 120s — the remote didn't \
             respond or git is waiting on credentials. Check your network and git \
             credential setup."
        ))),
    }
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

/// `git merge-base <a> <b>` — the most recent common ancestor of two refs.
/// This is the right `base_ref` anchor for the Changes pane: diffing against
/// it shows only what `<b>` has contributed since forking from `<a>`,
/// regardless of how far `<a>` has advanced or how stale the branch is.
/// Falls back to `b`'s sha if no common ancestor exists (orphan branches),
/// which collapses the Changes pane to "no changes" rather than blowing up.
pub async fn merge_base(repo_root: &Path, a: &str, b: &str) -> AppResult<String> {
    match git(repo_root, ["merge-base", a, b]).await {
        Ok(stdout) => Ok(stdout.trim().to_string()),
        Err(_) => rev_parse(repo_root, b).await,
    }
}

/// In-process `merge-base` via `git2` — sync, no subprocess. A standalone
/// primitive: `live_branch_anchor` inlines the equivalent over an already-open
/// repo (it compares two candidate bases), but this single-base form is handy
/// for tests and any future caller off the async runtime. Falls back to `b`'s
/// SHA on orphan branches / missing refs.
#[cfg_attr(not(test), allow(dead_code))]
pub fn merge_base_sync(repo_path: &Path, a: &str, b: &str) -> AppResult<String> {
    let repo = Repository::open(repo_path)?;
    let oid_a = repo.revparse_single(a)?.id();
    let oid_b = repo.revparse_single(b)?.id();
    match repo.merge_base(oid_a, oid_b) {
        Ok(oid) => Ok(oid.to_string()),
        Err(_) => Ok(oid_b.to_string()),
    }
}

/// The base ref a worktree's Branch-view diff compares against: the
/// workspace's configured override when set, else `origin/<default_branch>`.
///
/// `origin/<default>` is the default rather than local `<default>` because
/// that's the integration target the branch was forked from, and the one
/// GitHub/GitLab anchor their MR diff on. On squash-merge projects the two
/// diverge — the platform rewrites each merged branch into a *fresh* commit on
/// the remote, so local `<default>` (advanced by our own merge-backs, or just
/// stale) ends up on a different lineage and leaks every remote commit into
/// the diff. The user can override per workspace via the Changes-pane picker.
pub fn effective_base(default_branch: &str, override_ref: Option<&str>) -> String {
    match override_ref {
        Some(r) if !r.trim().is_empty() => r.trim().to_string(),
        _ => format!("origin/{default_branch}"),
    }
}

/// Resolve the Branch-view diff anchor for a worktree right now.
///
/// Cached `base_ref` on the `Worktree` only advances on in-app sync /
/// merge-back, so if the user rebases or merges main from a terminal the
/// anchor drifts and unrelated main commits leak into the Changes pane.
/// Recomputing the merge-base on every diff makes the cached value
/// advisory — it's only used as a fallback when the live computation
/// can't run (broken repo, missing refs).
///
/// The base is the merge-base of `configured_base` (from `effective_base` —
/// the per-workspace override, defaulting to `origin/<default>`) and the
/// branch. Local `<default>` is a safety net: if the configured ref can't be
/// resolved (no remote yet, unfetched, or a since-deleted ref) we fall back to
/// it before giving up to `fallback`. Refs are read as-of-last-fetch — no
/// fetch is performed here.
///
/// Returns `fallback` when `branch == default_branch` so the main-repo
/// worktree continues to show committed work in Branch view, or when no
/// candidate yields a merge-base (orphan branch / missing refs).
pub fn live_branch_anchor(
    repo_path: &Path,
    default_branch: &str,
    configured_base: &str,
    branch: &str,
    fallback: &str,
) -> String {
    if branch == default_branch {
        return fallback.to_string();
    }
    let Ok(repo) = Repository::open(repo_path) else {
        return fallback.to_string();
    };
    let Ok(head) = repo.revparse_single(branch).map(|o| o.id()) else {
        return fallback.to_string();
    };

    // Configured base wins; local `<default>` is the fallback when it can't be
    // resolved. merge-base keeps the diff to "what this branch adds."
    for base_ref in [configured_base, default_branch] {
        let Ok(base_oid) = repo.revparse_single(base_ref).map(|o| o.id()) else {
            continue;
        };
        if let Ok(mb) = repo.merge_base(base_oid, head) {
            return mb.to_string();
        }
    }
    fallback.to_string()
}

/// Branch refs offered in the Changes-pane base picker: local heads plus
/// remote-tracking branches (`git for-each-ref refs/heads refs/remotes`),
/// minus the `origin/HEAD` symbolic pointers. Sorted, deduped. Read-only, so
/// `git2` would do — but for-each-ref's `%(refname:short)` gives exactly the
/// short names we want to display and pass straight back as a base ref.
pub async fn list_branches(repo_root: &Path) -> AppResult<Vec<String>> {
    let stdout = git(
        repo_root,
        [
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .await?;
    let mut names: Vec<String> = stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.ends_with("/HEAD"))
        .map(str::to_string)
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
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

/// Pick the most up-to-date base ref for ahead/behind computations against
/// the workspace's default branch. When `origin/<default>` exists locally
/// and has commits the local `<default>` hasn't seen, use it — otherwise
/// fall back to `<default>`.
///
/// This handles the "stale local main" case: if the user hasn't pulled in
/// a while but their worktree branches were rooted on a newer base, using
/// local main produces wildly inflated ahead counts. No fetch is performed
/// — we only consult the refs already on disk.
pub async fn resolve_default_base(repo_root: &Path, default_branch: &str) -> String {
    let remote_ref = format!("origin/{default_branch}");
    // `git rev-parse --verify --quiet refs/remotes/origin/<default>` — exit
    // 0 iff the ref exists. `.output()` never errors on nonzero exit here,
    // so we inspect `status.success()`.
    let remote_exists = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{remote_ref}"),
        ])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !remote_exists {
        return default_branch.to_string();
    }
    // `git merge-base --is-ancestor A B` → exit 0 if A is ancestor of B.
    // If origin is ancestor of local, local is up-to-date or ahead → use
    // local. Else origin has commits local doesn't → use origin.
    let origin_is_ancestor_of_local = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args([
            "merge-base",
            "--is-ancestor",
            &remote_ref,
            default_branch,
        ])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    if origin_is_ancestor_of_local {
        default_branch.to_string()
    } else {
        remote_ref
    }
}

/// Single-call ahead/behind using `git rev-list --left-right --count
/// base...branch`. Returns `(ahead, behind)` where `ahead` is commits on
/// `branch` not on `base` and `behind` is commits on `base` not on `branch`.
pub async fn ahead_behind(
    repo_root: &Path,
    base: &str,
    branch: &str,
) -> AppResult<(u32, u32)> {
    let stdout = git(
        repo_root,
        [
            "rev-list".to_string(),
            "--left-right".to_string(),
            "--count".to_string(),
            format!("{base}...{branch}"),
        ],
    )
    .await?;
    let mut parts = stdout.split_whitespace();
    let behind: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok((ahead, behind))
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

/// Plain `git merge <branch>` into the current HEAD. Used by worktree
/// sync-from-default. Treat git's exit code as the success/failure signal;
/// caller distinguishes "conflict" by inspecting the error body.
pub async fn merge_into_current(repo_root: &Path, branch: &str) -> AppResult<()> {
    git(
        repo_root,
        ["merge", "--no-edit", branch],
    )
    .await
    .map(|_| ())
}

/// `git rebase <upstream>` in the given workdir. On any failure (typically a
/// conflict), automatically `git rebase --abort` so the workdir is left
/// clean — sparing users from having to know `git rebase --continue`. Caller
/// surfaces a "rebase aborted" result with the original git stderr.
pub async fn rebase_onto(workdir: &Path, upstream: &str) -> AppResult<()> {
    match git(workdir, ["rebase", upstream]).await {
        Ok(_) => Ok(()),
        Err(e) => {
            let _ = git(workdir, ["rebase", "--abort"]).await;
            Err(e)
        }
    }
}

/// Read a file's content at a specific ref via `git show <ref>:<path>`.
/// Returns `Ok(None)` if the path didn't exist at that ref (a legitimate
/// state for added / new files). Binary files come back as lossy-decoded
/// UTF-8 strings — callers that care about binary-vs-text should check
/// upstream before calling this.
pub async fn show_blob(
    repo_root: &Path,
    rev: &str,
    path: &str,
) -> AppResult<Option<String>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(["show", &format!("{rev}:{path}")])
        .output()
        .await?;
    if !out.status.success() {
        // git returns nonzero when the path doesn't exist at the given
        // ref (e.g., a file added on the worktree branch has no base-ref
        // version). Treat that as "empty content at base" rather than
        // surfacing an error.
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
}

/// `true` if merging `branch` into `base` produces a tree identical to
/// `base`'s current tree — i.e. the branch's work is already represented on
/// `base`, regardless of how it got there (merge, squash, rebase,
/// cherry-pick). Complements the SHA-only `ahead_behind`, which can't see
/// squash merges because they land as fresh commits with new SHAs.
///
/// Implementation: `git merge-tree --write-tree <base> <branch>` simulates
/// the merge without touching the working tree and prints the merged tree's
/// object id on stdout. We compare that to `<base>^{tree}`; if equal, the
/// branch contributes nothing new. On merge conflict or any git error we
/// return `false` (conservative — let the caller treat it as not-merged).
pub async fn effectively_merged(
    repo_root: &Path,
    base: &str,
    branch: &str,
) -> AppResult<bool> {
    // Short-circuit: if branch == base (fast-forwarded or same tip), tree
    // equality holds trivially and we can skip the merge-tree computation.
    if base == branch {
        return Ok(true);
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(["merge-tree", "--write-tree", base, branch])
        .output()
        .await?;
    if !out.status.success() {
        // Non-zero = merge would conflict. Conflict means the branch has
        // content the base lacks → not yet merged.
        return Ok(false);
    }
    let merged_tree = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if merged_tree.is_empty() {
        return Ok(false);
    }
    let base_tree = rev_parse(repo_root, &format!("{base}^{{tree}}")).await?;
    Ok(merged_tree == base_tree)
}

/// `git merge --ff-only <branch>` — refuses to merge if a fast-forward isn't
/// possible. Used by the merge-back "rebase + ff" strategy after the agent
/// branch has been rebased onto the default branch.
pub async fn merge_ff_only(repo_root: &Path, branch: &str) -> AppResult<()> {
    git(repo_root, ["merge", "--ff-only", branch]).await.map(|_| ())
}

/// Squash-merge `branch` into the current HEAD and commit with `message`.
/// This is two ops: `git merge --squash` (stages changes, no commit) then
/// `git commit -m "<message>"`. If either step fails, the caller should
/// decide whether to abort the merge.
pub async fn merge_squash_and_commit(
    repo_root: &Path,
    branch: &str,
    message: &str,
) -> AppResult<()> {
    git(repo_root, ["merge", "--squash", branch]).await?;
    // Use --cleanup=verbatim so leading whitespace / blank lines in the
    // user's message aren't silently stripped.
    git(
        repo_root,
        ["commit", "-m", message, "--cleanup=verbatim"],
    )
    .await?;
    Ok(())
}

/// `true` if the branch ref (e.g. "foo") exists locally.
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

/// `true` if `refs/remotes/<remote>/<branch>` exists.
pub async fn remote_branch_exists(
    repo_root: &Path,
    branch: &str,
    remote: &str,
) -> AppResult<bool> {
    let res = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{remote}/{branch}"),
        ])
        .output()
        .await?;
    Ok(res.status.success())
}

/// `git fetch --all --prune --quiet`. Best-effort: repos with no remotes
/// no-op silently; caller typically ignores the result and continues.
pub async fn fetch_all(repo_root: &Path) -> AppResult<()> {
    git(repo_root, ["fetch", "--all", "--prune", "--quiet"])
        .await
        .map(|_| ())
}

/// Add a worktree checking out an *already-existing* branch (no -b). Used
/// to reuse a local branch that's still around from a previous run.
pub async fn add_existing(
    repo_root: &Path,
    worktree_path: &Path,
    branch: &str,
) -> AppResult<()> {
    git(
        repo_root,
        [
            "worktree".as_ref(),
            "add".as_ref(),
            worktree_path.as_os_str(),
            branch.as_ref(),
        ],
    )
    .await
    .map(|_| ())
}

/// `git submodule update --init --recursive` in the given workdir. No-op
/// for repos without `.gitmodules`. Returns the git error if it fails so the
/// caller can decide whether to surface it (we keep the worktree alive
/// either way).
pub async fn update_submodules(workdir: &Path) -> AppResult<()> {
    git(
        workdir,
        ["submodule", "update", "--init", "--recursive"],
    )
    .await
    .map(|_| ())
}

/// Add a worktree creating a local branch that tracks `<remote>/<branch>`.
/// Used when only a remote ref exists and we want a proper local counterpart.
pub async fn add_tracking(
    repo_root: &Path,
    worktree_path: &Path,
    new_branch: &str,
    remote: &str,
) -> AppResult<()> {
    let remote_ref = format!("{remote}/{new_branch}");
    git(
        repo_root,
        [
            "worktree".as_ref(),
            "add".as_ref(),
            "-b".as_ref(),
            new_branch.as_ref(),
            worktree_path.as_os_str(),
            remote_ref.as_ref(),
        ],
    )
    .await
    .map(|_| ())
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
    use crate::test_support::TempRepo;

    // --- Pure ---

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

    // --- Integration against a real temp repo ---

    #[tokio::test]
    async fn rev_parse_resolves_head_symbol() {
        let r = TempRepo::new();
        let sha = rev_parse(&r.root, "HEAD").await.unwrap();
        assert_eq!(sha, r.head());
    }

    #[tokio::test]
    async fn current_branch_reads_main() {
        let r = TempRepo::new();
        assert_eq!(current_branch(&r.root).await.unwrap(), "main");
    }

    #[tokio::test]
    async fn branch_exists_true_for_main_false_for_missing() {
        let r = TempRepo::new();
        assert!(branch_exists(&r.root, "main").await.unwrap());
        assert!(!branch_exists(&r.root, "does-not-exist").await.unwrap());
    }

    #[tokio::test]
    async fn has_changes_flips_after_edit() {
        let r = TempRepo::new();
        assert!(!has_changes(&r.root).await.unwrap());
        std::fs::write(r.root.join("README.md"), "changed\n").unwrap();
        assert!(has_changes(&r.root).await.unwrap());
    }

    #[tokio::test]
    async fn commits_ahead_and_ahead_behind_match() {
        let r = TempRepo::new();
        // Branch off main, add a commit on it.
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["checkout", "-q", "-b", "feature"])
            .status()
            .unwrap();
        assert!(out.success());
        r.commit_file("new.txt", "hello\n", "feature: add new.txt");

        let ahead = commits_ahead(&r.root, "main", "feature").await.unwrap();
        assert_eq!(ahead, 1);
        let (a, b) = ahead_behind(&r.root, "main", "feature").await.unwrap();
        assert_eq!((a, b), (1, 0));
        // Back to main: feature is now 1 ahead of main, main is 0 ahead of feature.
    }

    #[tokio::test]
    async fn merge_no_ff_creates_merge_commit() {
        let r = TempRepo::new();
        let base = r.head();
        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["checkout", "-q", "-b", "feature"])
            .status();
        r.commit_file("f.txt", "f\n", "feat");
        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["checkout", "-q", "main"])
            .status();
        merge_no_ff(&r.root, "feature").await.unwrap();
        // main should now have 2 commits beyond the pre-merge base: the
        // feature commit + the merge commit.
        let after = commits_ahead(&r.root, &base, "main").await.unwrap();
        assert_eq!(after, 2);
    }

    #[tokio::test]
    async fn merge_squash_and_commit_yields_single_commit() {
        let r = TempRepo::new();
        let base = r.head();
        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["checkout", "-q", "-b", "feature"])
            .status();
        r.commit_file("a.txt", "a\n", "a");
        r.commit_file("b.txt", "b\n", "b");
        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["checkout", "-q", "main"])
            .status();
        merge_squash_and_commit(&r.root, "feature", "squashed").await.unwrap();
        let after = commits_ahead(&r.root, &base, "main").await.unwrap();
        // Exactly one new commit on main (the squash) even though feature
        // had two.
        assert_eq!(after, 1);
    }

    #[tokio::test]
    async fn remote_branch_exists_false_on_repo_with_no_remote() {
        let r = TempRepo::new();
        assert!(!remote_branch_exists(&r.root, "main", "origin")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn fetch_all_is_a_clean_noop_without_remotes() {
        let r = TempRepo::new();
        // Best-effort contract: no remotes means nothing to fetch, not an
        // error. Also exercises the path in manager::create.
        fetch_all(&r.root).await.unwrap();
    }

    #[tokio::test]
    async fn resolve_default_base_returns_local_when_no_origin() {
        let r = TempRepo::new();
        let base = resolve_default_base(&r.root, "main").await;
        assert_eq!(base, "main");
    }

    #[tokio::test]
    async fn resolve_default_base_returns_local_when_origin_is_ancestor() {
        let r = TempRepo::new();
        // Advance local main.
        let m1 = r.commit_file("a.txt", "a\n", "a");
        // Set refs/remotes/origin/main to the initial commit (before M1) →
        // origin is ancestor of local.
        let parent = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["rev-parse", &format!("{m1}^")])
            .output()
            .unwrap();
        let parent_sha = String::from_utf8(parent.stdout).unwrap().trim().to_string();
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["update-ref", "refs/remotes/origin/main", &parent_sha])
            .status()
            .unwrap();
        assert!(ok.success());

        let base = resolve_default_base(&r.root, "main").await;
        assert_eq!(base, "main", "local is ahead of origin → use local");
    }

    #[tokio::test]
    async fn resolve_default_base_returns_origin_when_local_is_stale() {
        let r = TempRepo::new();
        // Advance local past the initial commit, capture its SHA, then
        // point refs/remotes/origin/main at it — origin "ahead" of where
        // we'll leave local.
        let m1 = r.commit_file("a.txt", "a\n", "a");
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["update-ref", "refs/remotes/origin/main", &m1])
            .status()
            .unwrap();
        assert!(ok.success());
        // Roll local main back to the pre-M1 commit so origin is strictly
        // ahead of local.
        let parent = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["rev-parse", &format!("{m1}^")])
            .output()
            .unwrap();
        let parent_sha = String::from_utf8(parent.stdout).unwrap().trim().to_string();
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["update-ref", "refs/heads/main", &parent_sha])
            .status()
            .unwrap();
        assert!(ok.success());

        let base = resolve_default_base(&r.root, "main").await;
        assert_eq!(base, "origin/main", "origin is ahead of local → use origin");
    }

    #[tokio::test]
    async fn effectively_merged_trivially_true_when_branch_at_base() {
        let r = TempRepo::new();
        // Fresh branch off main at the same commit — no unique work.
        run_git(&r.root, &["checkout", "-q", "-b", "feature"]);
        assert!(effectively_merged(&r.root, "main", "feature").await.unwrap());
    }

    #[tokio::test]
    async fn effectively_merged_false_when_branch_has_unique_work() {
        let r = TempRepo::new();
        run_git(&r.root, &["checkout", "-q", "-b", "feature"]);
        r.commit_file("new.txt", "hi\n", "feature");
        assert!(!effectively_merged(&r.root, "main", "feature").await.unwrap());
    }

    #[tokio::test]
    async fn effectively_merged_true_after_squash_merge() {
        let r = TempRepo::new();
        run_git(&r.root, &["checkout", "-q", "-b", "feature"]);
        r.commit_file("a.txt", "a\n", "a");
        r.commit_file("b.txt", "b\n", "b");
        // Squash-merge feature into main — main gets ONE new commit whose
        // tree matches feature's tree.
        run_git(&r.root, &["checkout", "-q", "main"]);
        merge_squash_and_commit(&r.root, "feature", "squashed").await.unwrap();
        // Classic SHA-only ahead_behind still reports feature as 2 ahead of
        // main because the squash commit has a different SHA. This check
        // should see through that.
        assert!(effectively_merged(&r.root, "main", "feature").await.unwrap());
    }

    #[tokio::test]
    async fn effectively_merged_false_when_conflict_would_occur() {
        let r = TempRepo::new();
        run_git(&r.root, &["checkout", "-q", "-b", "feature"]);
        r.commit_file("README.md", "feature\n", "feature edit");
        run_git(&r.root, &["checkout", "-q", "main"]);
        r.commit_file("README.md", "main\n", "main edit");
        // Feature and main have divergent edits to the same file — a merge
        // would conflict. merge-tree exits nonzero; we treat as not-merged.
        assert!(!effectively_merged(&r.root, "main", "feature").await.unwrap());
    }

    fn run_git(root: &std::path::Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    #[tokio::test]
    async fn rebase_auto_aborts_on_conflict() {
        let r = TempRepo::new();
        // Divergent edits to the same file → conflict on rebase.
        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["checkout", "-q", "-b", "feature"])
            .status();
        r.commit_file("README.md", "feature\n", "feature edit");
        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["checkout", "-q", "main"])
            .status();
        r.commit_file("README.md", "main\n", "main edit");
        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["checkout", "-q", "feature"])
            .status();

        let err = rebase_onto(&r.root, "main").await.unwrap_err();
        assert!(matches!(err, AppError::GitError(_)));
        // Auto-abort: no residual rebase state left behind.
        assert!(!r.root.join(".git/rebase-apply").exists());
        assert!(!r.root.join(".git/rebase-merge").exists());
    }

    /// External rebase (terminal `git rebase main`, not in-app sync) advances
    /// the branch's fork-point. The cached `base_ref` we hand in as fallback
    /// is the *stale* one — `live_branch_anchor` must look past it to the
    /// current merge-base, otherwise every commit main has gained since the
    /// branch was created shows up as a branch change. This is the exact
    /// failure mode users hit on squash-merge projects where rebases are
    /// frequent.
    #[tokio::test]
    async fn live_branch_anchor_tracks_external_rebase() {
        let r = TempRepo::new();
        let initial_main = r.head();

        // Branch `feat` off the initial commit, add two commits.
        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["checkout", "-q", "-b", "feat"])
            .status();
        r.commit_file("x.txt", "x\n", "X");
        r.commit_file("y.txt", "y\n", "Y");

        // Advance main with unrelated commits (simulating squash-merges).
        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["checkout", "-q", "main"])
            .status();
        r.commit_file("b.txt", "b\n", "B");
        let new_main = r.commit_file("c.txt", "c\n", "C");

        // Fork-point right now is still the initial commit. Worktree creation
        // would have captured this as `base_ref`.
        let captured_base = merge_base_sync(&r.root, "main", "feat").unwrap();
        assert_eq!(captured_base, initial_main);

        // External rebase moves feat onto main's current tip.
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["checkout", "-q", "feat"])
            .status()
            .unwrap();
        assert!(status.success());
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&r.root)
            .args(["rebase", "-q", "main"])
            .status()
            .unwrap();
        assert!(status.success());

        // Cached anchor is now stale. With no remote, the default
        // `origin/main` base can't resolve, so it falls back to local `main`
        // and must return the current merge-base (main's tip), not the stale
        // fallback.
        let anchor = live_branch_anchor(&r.root, "main", "origin/main", "feat", &captured_base);
        assert_eq!(
            anchor, new_main,
            "expected live merge-base at main's tip, got stale fallback"
        );
        assert_ne!(anchor, initial_main);
    }

    /// Squash-merge projects rewrite each merged branch into a fresh commit on
    /// `origin/<default>`, so local `main` (advanced by our own merge-backs, or
    /// just stale) lands on a *different* lineage than the worktree branch —
    /// which was forked from `origin/main`. Anchoring on local `main` then
    /// shares only the ancient root with the branch and leaks every remote
    /// commit into the diff. The anchor must prefer the `origin/main`
    /// merge-base, matching the GitHub/GitLab MR diff. This is the exact bug
    /// users hit on squash-merge projects.
    #[test]
    fn live_branch_anchor_prefers_origin_when_local_main_diverged() {
        let r = TempRepo::new();
        let initial = r.head();

        // Advance main with a commit, then publish it to a bare `origin`.
        // Commit O is feat's true fork point on the remote lineage.
        let on_main = r.commit_file("o.txt", "o\n", "O");
        let bare = r.root.parent().unwrap().join("origin.git");
        run_git(&r.root, &["init", "--bare", "-q", bare.to_str().unwrap()]);
        run_git(&r.root, &["remote", "add", "origin", bare.to_str().unwrap()]);
        run_git(&r.root, &["push", "-q", "origin", "main"]);
        run_git(&r.root, &["fetch", "-q", "origin"]);

        // Branch off the remote lineage (main is at O), add the branch's work.
        run_git(&r.root, &["checkout", "-q", "-b", "feat"]);
        r.commit_file("f.txt", "f\n", "F");

        // Now diverge LOCAL main onto another lineage: reset to root + add an
        // unrelated commit (an in-app merge-back, say). origin/main stays at O;
        // local main no longer contains O.
        run_git(&r.root, &["checkout", "-q", "main"]);
        run_git(&r.root, &["reset", "--hard", "-q", &initial]);
        r.commit_file("l.txt", "l\n", "L");
        run_git(&r.root, &["checkout", "-q", "feat"]);

        // Sanity: the two candidate merge-bases really do differ.
        let local_mb = merge_base_sync(&r.root, "main", "feat").unwrap();
        let origin_mb = merge_base_sync(&r.root, "origin/main", "feat").unwrap();
        assert_eq!(local_mb, initial, "local main shares only the root with feat");
        assert_eq!(origin_mb, on_main, "origin/main is feat's true fork point");
        assert_ne!(local_mb, origin_mb);

        // With the default base (origin/main), the anchor must pick the origin
        // merge-base (O), not local main's stale root — else commit O leaks
        // into the Changes pane as a branch change.
        let anchor = live_branch_anchor(&r.root, "main", "origin/main", "feat", &local_mb);
        assert_eq!(
            anchor, on_main,
            "expected origin/main merge-base, got local-main's stale root"
        );

        // An explicit override to local `main` flips it back to local's root.
        let local_anchor = live_branch_anchor(&r.root, "main", "main", "feat", &local_mb);
        assert_eq!(local_anchor, initial, "explicit local-main override ignored");
    }

    /// On the main-clone worktree (branch == default_branch), the live anchor
    /// is meaningless — `merge_base(main, main)` is just HEAD, which would
    /// collapse Branch view to "no committed changes." Preserve the cached
    /// fallback instead so committed work on main still surfaces.
    #[test]
    fn live_branch_anchor_keeps_fallback_for_default_branch() {
        let r = TempRepo::new();
        let pinned = r.head();
        // Advance main; cached fallback stays at the original sha.
        r.commit_file("z.txt", "z\n", "Z");

        let anchor = live_branch_anchor(&r.root, "main", "origin/main", "main", &pinned);
        assert_eq!(anchor, pinned);
    }
}
