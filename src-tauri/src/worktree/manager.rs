use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::state::AppState;
use crate::util::errors::{AppError, AppResult};
use crate::util::ids::{WorkspaceId, WorktreeId};

use super::{git_ops, Worktree};

/// Tunable knobs for `create`. Pass `Default::default()` for "old" behavior.
#[derive(Debug, Clone, Copy, Default)]
pub struct CreateOptions {
    pub init_submodules: bool,
}

/// What `create` returns: the worktree, plus an optional non-fatal warning
/// (e.g. submodule init failed). The worktree itself is alive on disk and
/// usable in either case.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreateWorktreeResult {
    pub worktree: Worktree,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SyncStrategy {
    /// `git merge <default>` — adds a merge commit, conflicts left in workdir.
    Merge,
    /// `git rebase <default>` — replays agent commits on top of default.
    /// On conflict we auto-abort so the workdir is left clean.
    #[default]
    Rebase,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MergeBackStrategy {
    /// `git merge --no-ff <branch>` on default — preserves branch history.
    MergeNoFf,
    /// `git merge --squash <branch>` on default + commit with message.
    Squash,
    /// Rebase the agent branch onto default, then ff-only merge — linear
    /// history, no merge commit.
    #[default]
    RebaseFf,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum SyncResult {
    /// Pulled cleanly — the worktree now has every commit from the default
    /// branch. New `head` sha returned.
    Clean { head: String },
    /// Already includes everything from the default branch — nothing to do.
    AlreadyUpToDate,
    /// Workdir has uncommitted changes; the merge/rebase would clobber them.
    /// User should commit (or stash manually) first.
    Dirty,
    /// Merge attempted but produced conflicts. The conflicts are sitting in
    /// the workdir for the user to resolve in the worktree's terminal.
    Conflict { message: String },
    /// Rebase produced conflicts; auto-aborted so the workdir is clean. User
    /// can retry with the merge strategy or resolve the underlying issue.
    RebaseAborted { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum MergeResult {
    Clean,
    /// Branch has no commits beyond base. `uncommittedChanges` is true when
    /// the worktree has unstaged work the user needs to commit first.
    NothingToMerge {
        #[serde(rename = "uncommittedChanges")]
        uncommitted_changes: bool,
    },
    Conflict { message: String },
    /// Rebase pre-step (RebaseFf strategy) produced conflicts and was
    /// auto-aborted; nothing was merged. Try MergeNoFf or resolve the
    /// underlying drift first.
    RebaseAborted { message: String },
    /// Main repo is not on the default branch; user must check it out first.
    WrongBranch { current: String, expected: String },
}

/// Create a new worktree under `<repo>__worktrees/<slug>/` on branch `<slug>`.
/// `name` is a friendly label; it's slugified into the path + branch.
/// Worktrees adopted from earlier versions may carry an `agent/<slug>` branch
/// — reconcile handles those transparently.
pub async fn create(
    workspace_id: WorkspaceId,
    name: &str,
    opts: CreateOptions,
    state: &AppState,
) -> AppResult<CreateWorktreeResult> {
    let ws = state
        .workspaces
        .get(&workspace_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {workspace_id}")))?
        .clone();

    let slug = git_ops::slugify(name);
    let branch = slug.clone();
    let root = git_ops::worktrees_root_for(&ws.root);
    let path: PathBuf = root.join(&slug);

    if path.exists() {
        return Err(AppError::AlreadyOpen(format!(
            "worktree dir exists: {}",
            path.display()
        )));
    }
    tokio::fs::create_dir_all(&root).await?;

    // Fetch so we consider remote refs too. Best-effort: repos without a
    // remote configured silently no-op.
    let _ = git_ops::fetch_all(&ws.root).await;

    let local_exists = git_ops::branch_exists(&ws.root, &branch).await?;
    let remote_exists = git_ops::remote_branch_exists(&ws.root, &branch, "origin")
        .await
        .unwrap_or(false);

    // base_ref is the comparison anchor for the Changes pane — use
    // default's current tip so anything on the (new or reused) branch
    // beyond default shows as pending.
    let base_sha = git_ops::rev_parse(&ws.root, &ws.default_branch).await?;

    let head_sha = if local_exists {
        tracing::info!(%branch, "reusing existing local branch");
        git_ops::add_existing(&ws.root, &path, &branch).await?;
        git_ops::rev_parse(&ws.root, &branch)
            .await
            .unwrap_or_else(|_| base_sha.clone())
    } else if remote_exists {
        tracing::info!(%branch, "reusing origin/{branch} as new local tracking branch");
        git_ops::add_tracking(&ws.root, &path, &branch, "origin").await?;
        git_ops::rev_parse(&ws.root, &branch)
            .await
            .unwrap_or_else(|_| base_sha.clone())
    } else {
        git_ops::add(&ws.root, &path, &branch, &ws.default_branch).await?;
        base_sha.clone()
    };

    let worktree = Worktree {
        id: WorktreeId::new(),
        workspace_id,
        path,
        branch,
        base_ref: base_sha,
        head: head_sha,
        dirty: false,
        is_main_clone: false,
    };
    state.worktrees.insert(worktree.id, worktree.clone());
    tracing::info!(id = %worktree.id, path = %worktree.path.display(), "created worktree");

    // Optional submodule init. Failure surfaces as a non-fatal warning so the
    // worktree is still usable; the user can rerun the git command manually
    // if it was a transient/auth issue.
    let warning = if opts.init_submodules {
        match git_ops::update_submodules(&worktree.path).await {
            Ok(()) => None,
            Err(AppError::GitError(msg)) | Err(AppError::Io(msg)) | Err(AppError::Unknown(msg)) => {
                tracing::warn!(id = %worktree.id, %msg, "submodule init failed");
                Some(format!("Submodule init failed: {msg}"))
            }
            Err(e) => Some(e.to_string()),
        }
    } else {
        None
    };

    Ok(CreateWorktreeResult { worktree, warning })
}

pub async fn sync_with_default(
    worktree_id: WorktreeId,
    strategy: SyncStrategy,
    state: &AppState,
) -> AppResult<SyncResult> {
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();
    if wt.is_main_clone {
        return Err(AppError::Unknown("cannot sync the main clone".into()));
    }
    let ws = state
        .workspaces
        .get(&wt.workspace_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {}", wt.workspace_id)))?
        .clone();

    // Nothing to do if there's no behind state.
    let behind = git_ops::commits_ahead(&ws.root, &wt.branch, &ws.default_branch)
        .await
        .unwrap_or(0);
    if behind == 0 {
        return Ok(SyncResult::AlreadyUpToDate);
    }

    // Refuse if the workdir has uncommitted edits. Both merge and rebase
    // would refuse anyway, and per the no-auto-commit rule we don't stash
    // on the user's behalf.
    if git_ops::has_changes(&wt.path).await.unwrap_or(false) {
        return Ok(SyncResult::Dirty);
    }

    let op = match strategy {
        SyncStrategy::Merge => git_ops::merge_into_current(&wt.path, &ws.default_branch).await,
        SyncStrategy::Rebase => git_ops::rebase_onto(&wt.path, &ws.default_branch).await,
    };

    match op {
        Ok(()) => {
            let new_head = git_ops::rev_parse(&wt.path, "HEAD")
                .await
                .unwrap_or_default();
            // After sync, the branch now contains every commit on default.
            // Advance `base_ref` to default's current HEAD so the Changes
            // list reflects "what's on this branch beyond default" cleanly
            // — everything we just pulled in is no longer highlighted as
            // pending.
            let new_base = git_ops::rev_parse(&ws.root, &ws.default_branch)
                .await
                .unwrap_or_else(|_| new_head.clone());
            if let Some(mut entry) = state.worktrees.get_mut(&worktree_id) {
                entry.head = new_head.clone();
                entry.base_ref = new_base;
            }
            tracing::info!(
                id = %worktree_id,
                new_head = %new_head,
                ?strategy,
                "synced worktree"
            );
            Ok(SyncResult::Clean { head: new_head })
        }
        Err(AppError::GitError(msg)) => {
            tracing::warn!(id = %worktree_id, %msg, ?strategy, "sync conflicts");
            match strategy {
                SyncStrategy::Merge => Ok(SyncResult::Conflict { message: msg }),
                SyncStrategy::Rebase => Ok(SyncResult::RebaseAborted { message: msg }),
            }
        }
        Err(e) => Err(e),
    }
}

pub async fn remove(
    worktree_id: WorktreeId,
    force: bool,
    state: &AppState,
) -> AppResult<()> {
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();
    if wt.is_main_clone {
        return Err(AppError::Unknown("cannot remove the main clone".into()));
    }
    let ws = state
        .workspaces
        .get(&wt.workspace_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {}", wt.workspace_id)))?
        .clone();

    git_ops::remove(&ws.root, &wt.path, force).await?;

    // Best-effort: delete the branch we created (ignore errors; user may have
    // merged it or renamed it). Later milestones will handle merge-back.
    let _ = tokio::process::Command::new("git")
        .arg("-C")
        .arg(&ws.root)
        .args(["branch", "-D", &wt.branch])
        .output()
        .await;

    state.worktrees.remove(&worktree_id);
    tracing::info!(id = %worktree_id, "removed worktree");
    Ok(())
}

pub async fn merge(
    worktree_id: WorktreeId,
    strategy: MergeBackStrategy,
    commit_message: Option<String>,
    state: &AppState,
) -> AppResult<MergeResult> {
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();
    if wt.is_main_clone {
        return Err(AppError::Unknown("cannot merge the main clone into itself".into()));
    }
    let ws = state
        .workspaces
        .get(&wt.workspace_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {}", wt.workspace_id)))?
        .clone();

    // Serialize merges across the process so two simultaneous merge clicks
    // don't tangle the main repo's index.
    let _guard = state.merge_lock.lock().await;

    let current = git_ops::current_branch(&ws.root).await?;
    if current != ws.default_branch {
        return Ok(MergeResult::WrongBranch {
            current,
            expected: ws.default_branch.clone(),
        });
    }

    // If the agent branch has nothing beyond base, the merge would be a no-op.
    let ahead = git_ops::commits_ahead(&ws.root, &ws.default_branch, &wt.branch).await?;
    if ahead == 0 {
        let dirty = git_ops::has_changes(&wt.path).await.unwrap_or(false);
        return Ok(MergeResult::NothingToMerge {
            uncommitted_changes: dirty,
        });
    }

    let op_result = match strategy {
        MergeBackStrategy::MergeNoFf => git_ops::merge_no_ff(&ws.root, &wt.branch).await,
        MergeBackStrategy::Squash => {
            let msg = commit_message
                .as_deref()
                .map(str::trim)
                .unwrap_or("");
            if msg.is_empty() {
                return Err(AppError::Unknown(
                    "squash merge requires a commit message".into(),
                ));
            }
            git_ops::merge_squash_and_commit(&ws.root, &wt.branch, msg).await
        }
        MergeBackStrategy::RebaseFf => {
            // Rebase the agent branch onto default *inside the worktree*,
            // then ff-only merge in the main repo. If rebase fails it
            // auto-aborts so we never leave a half-rebased branch behind.
            match git_ops::rebase_onto(&wt.path, &ws.default_branch).await {
                Ok(()) => git_ops::merge_ff_only(&ws.root, &wt.branch).await,
                Err(AppError::GitError(msg)) => {
                    tracing::warn!(
                        id = %worktree_id,
                        %msg,
                        "rebase pre-step aborted"
                    );
                    return Ok(MergeResult::RebaseAborted { message: msg });
                }
                Err(e) => return Err(e),
            }
        }
    };

    match op_result {
        Ok(()) => {
            // Merge-back advances default's HEAD but leaves the merged
            // worktree's files untouched. Re-anchor its `base_ref` so the
            // Changes list collapses to just whatever's still pending.
            //
            // The main clone ALSO needs updating: its workdir just advanced
            // (`git merge` moves HEAD + updates files in the main repo
            // we ran it in), but our cached `base_ref` and `head` are from
            // before. Otherwise the main clone's DiffPane will keep showing
            // the merged-in commits as pending changes.
            let new_base = git_ops::rev_parse(&ws.root, &ws.default_branch)
                .await
                .unwrap_or_default();
            if let Some(mut entry) = state.worktrees.get_mut(&worktree_id) {
                entry.base_ref = new_base.clone();
            }
            let main_clone_id: Option<WorktreeId> = state
                .worktrees
                .iter()
                .find(|e| {
                    e.value().workspace_id == wt.workspace_id && e.value().is_main_clone
                })
                .map(|e| *e.key());
            if let Some(id) = main_clone_id {
                if let Some(mut entry) = state.worktrees.get_mut(&id) {
                    entry.base_ref = new_base.clone();
                    entry.head = new_base.clone();
                }
            }
            tracing::info!(
                id = %worktree_id,
                branch = %wt.branch,
                ?strategy,
                "merged worktree"
            );
            Ok(MergeResult::Clean)
        }
        Err(AppError::GitError(msg)) => {
            tracing::warn!(id = %worktree_id, %msg, "merge produced conflicts");
            Ok(MergeResult::Conflict { message: msg })
        }
        Err(e) => Err(e),
    }
}

pub fn list_for_workspace(workspace_id: WorkspaceId, state: &AppState) -> Vec<Worktree> {
    // DashMap iteration order is non-deterministic; sorting by id (ULID →
    // lexicographic == creation order) keeps the sidebar stable across
    // refreshes so the main clone stays pinned at the top and newer
    // worktrees always append below.
    let mut out: Vec<Worktree> = state
        .worktrees
        .iter()
        .filter_map(|entry| {
            let v = entry.value();
            if v.workspace_id == workspace_id {
                Some(v.clone())
            } else {
                None
            }
        })
        .collect();
    out.sort_by_key(|w| w.id);
    out
}

/// Walk `git worktree list --porcelain` for the given workspace, find entries
/// that live under our `<repo>__worktrees/` dir, and adopt any we don't already
/// track. Also prunes git's metadata for any worktree whose path has vanished.
pub async fn reconcile(workspace_id: WorkspaceId, state: &AppState) -> AppResult<()> {
    let ws = state
        .workspaces
        .get(&workspace_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {workspace_id}")))?
        .clone();

    let _ = git_ops::prune(&ws.root).await;

    let root = git_ops::worktrees_root_for(&ws.root);
    // Canonicalize so platforms that symlink temp dirs (macOS /tmp →
    // /private/tmp) don't cause `starts_with` to miss legitimate entries.
    let canon_root = dunce::canonicalize(&root).unwrap_or_else(|_| root.clone());
    let entries = git_ops::list(&ws.root).await?;

    let existing_paths: std::collections::HashSet<PathBuf> = state
        .worktrees
        .iter()
        .filter(|e| e.value().workspace_id == workspace_id)
        .map(|e| e.value().path.clone())
        .collect();

    for entry in entries {
        let canon_entry =
            dunce::canonicalize(&entry.path).unwrap_or_else(|_| entry.path.clone());
        if !canon_entry.starts_with(&canon_root) {
            continue; // user-managed worktree outside our convention
        }
        if existing_paths.contains(&entry.path) {
            continue;
        }
        let branch = match entry.branch.clone() {
            Some(b) => b,
            None => continue,
        };
        let head = if entry.head.is_empty() {
            continue;
        } else {
            entry.head.clone()
        };
        let worktree = Worktree {
            id: WorktreeId::new(),
            workspace_id,
            path: entry.path,
            branch,
            base_ref: head.clone(),
            head,
            dirty: false,
            is_main_clone: false,
        };
        tracing::info!(id = %worktree.id, path = %worktree.path.display(), "adopted worktree");
        state.worktrees.insert(worktree.id, worktree);
    }

    Ok(())
}

/// Create the synthetic entry for the main repo's own workdir, so the sidebar
/// can show it alongside agent worktrees (read-only tools only — no launch,
/// no merge, no remove).
pub async fn register_main_clone(
    workspace_id: WorkspaceId,
    state: &AppState,
) -> AppResult<Worktree> {
    let ws = state
        .workspaces
        .get(&workspace_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {workspace_id}")))?
        .clone();

    // If one is already registered (re-open), reuse it.
    if let Some(existing) = state
        .worktrees
        .iter()
        .find(|e| e.value().workspace_id == workspace_id && e.value().is_main_clone)
    {
        return Ok(existing.value().clone());
    }

    let branch = git_ops::current_branch(&ws.root).await.unwrap_or_else(|_| ws.default_branch.clone());
    let head = git_ops::rev_parse(&ws.root, "HEAD").await.unwrap_or_default();

    let worktree = Worktree {
        id: WorktreeId::new(),
        workspace_id,
        path: ws.root.clone(),
        branch,
        base_ref: head.clone(),
        head,
        dirty: false,
        is_main_clone: true,
    };
    state.worktrees.insert(worktree.id, worktree.clone());
    tracing::info!(id = %worktree.id, path = %worktree.path.display(), "registered main clone");
    Ok(worktree)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use crate::test_support::{workspace_fixture, TempRepo};

    /// Helper: make an AppState + workspace rooted at `repo.root`.
    fn setup(repo: &TempRepo) -> (AppState, WorkspaceId) {
        let state = AppState::new();
        let ws = workspace_fixture(&state, &repo.root);
        (state, ws.id)
    }

    #[tokio::test]
    async fn create_produces_worktree_on_disk_and_in_state() {
        let repo = TempRepo::new();
        let (state, ws_id) = setup(&repo);
        let wt = create(ws_id, "first", CreateOptions::default(), &state).await.unwrap().worktree;

        assert_eq!(wt.branch, "first");
        assert!(wt.path.exists(), "worktree dir should exist on disk");
        assert!(
            wt.path.join(".git").exists(),
            "worktree should be a git workdir"
        );
        assert_eq!(state.worktrees.len(), 1);
    }

    #[tokio::test]
    async fn create_errors_when_worktree_dir_already_exists() {
        let repo = TempRepo::new();
        let (state, ws_id) = setup(&repo);
        create(ws_id, "same", CreateOptions::default(), &state).await.unwrap().worktree;
        // The first create left a dir on disk; second should refuse.
        let err = create(ws_id, "same", CreateOptions::default(), &state).await.unwrap_err();
        assert!(matches!(err, AppError::AlreadyOpen(_)));
    }

    #[tokio::test]
    async fn create_reuses_preexisting_local_branch() {
        let repo = TempRepo::new();
        let (state, ws_id) = setup(&repo);
        // Simulate a branch that already exists — e.g. the user created it
        // in a terminal, or it was fetched from elsewhere. We need a commit
        // on it so reuse is observably different from a fresh branch.
        run_in(&repo.root, &["branch", "reused", "main"]);
        run_in(&repo.root, &["checkout", "-q", "reused"]);
        std::fs::write(repo.root.join("carried-over.txt"), "prior work\n")
            .unwrap();
        run_in(&repo.root, &["add", "carried-over.txt"]);
        run_in(&repo.root, &["commit", "-q", "-m", "prior"]);
        let expected_head = repo.head();
        run_in(&repo.root, &["checkout", "-q", "main"]);

        let wt = create(ws_id, "reused", CreateOptions::default(), &state).await.unwrap().worktree;
        assert_eq!(wt.head, expected_head, "reused branch's HEAD should carry over");
        assert!(
            wt.path.join("carried-over.txt").exists(),
            "worktree should check out the existing branch's files"
        );
    }

    #[tokio::test]
    async fn remove_deletes_directory_and_state() {
        let repo = TempRepo::new();
        let (state, ws_id) = setup(&repo);
        let wt = create(ws_id, "doomed", CreateOptions::default(), &state).await.unwrap().worktree;
        let path = wt.path.clone();
        remove(wt.id, true, &state).await.unwrap();
        assert!(!path.exists());
        assert_eq!(state.worktrees.len(), 0);
    }

    #[tokio::test]
    async fn remove_refuses_main_clone() {
        let repo = TempRepo::new();
        let (state, ws_id) = setup(&repo);
        let main = register_main_clone(ws_id, &state).await.unwrap();
        let err = remove(main.id, false, &state).await.unwrap_err();
        assert!(matches!(err, AppError::Unknown(msg) if msg.contains("main clone")));
    }

    #[tokio::test]
    async fn register_main_clone_is_idempotent() {
        let repo = TempRepo::new();
        let (state, ws_id) = setup(&repo);
        let a = register_main_clone(ws_id, &state).await.unwrap();
        let b = register_main_clone(ws_id, &state).await.unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(
            state
                .worktrees
                .iter()
                .filter(|e| e.value().is_main_clone)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn merge_reports_nothing_when_branch_has_no_extra_commits() {
        let repo = TempRepo::new();
        let (state, ws_id) = setup(&repo);
        let wt = create(ws_id, "empty", CreateOptions::default(), &state).await.unwrap().worktree;
        let r = merge(wt.id, MergeBackStrategy::MergeNoFf, None, &state)
            .await
            .unwrap();
        match r {
            MergeResult::NothingToMerge { uncommitted_changes } => {
                assert!(!uncommitted_changes);
            }
            other => panic!("expected NothingToMerge, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn merge_reports_wrong_branch_when_main_not_on_default() {
        let repo = TempRepo::new();
        let (state, ws_id) = setup(&repo);
        let wt = create(ws_id, "feature", CreateOptions::default(), &state).await.unwrap().worktree;

        // Give the worktree a commit so it's ahead of default.
        std::fs::write(wt.path.join("a.txt"), "a\n").unwrap();
        run_in(&wt.path, &["add", "a.txt"]);
        run_in(&wt.path, &["commit", "-q", "-m", "a"]);

        // Move the main repo onto a side branch so WrongBranch triggers.
        run_in(&repo.root, &["checkout", "-q", "-b", "sidebar"]);

        let r = merge(wt.id, MergeBackStrategy::MergeNoFf, None, &state)
            .await
            .unwrap();
        assert!(matches!(r, MergeResult::WrongBranch { .. }));
    }

    #[tokio::test]
    async fn merge_mergenoff_lands_one_commit_on_default() {
        let repo = TempRepo::new();
        let base = repo.head();
        let (state, ws_id) = setup(&repo);
        let wt = create(ws_id, "work", CreateOptions::default(), &state).await.unwrap().worktree;

        std::fs::write(wt.path.join("x.txt"), "x\n").unwrap();
        run_in(&wt.path, &["add", "x.txt"]);
        run_in(&wt.path, &["commit", "-q", "-m", "x"]);

        let r = merge(wt.id, MergeBackStrategy::MergeNoFf, None, &state)
            .await
            .unwrap();
        assert!(matches!(r, MergeResult::Clean));

        let ahead = super::git_ops::commits_ahead(&repo.root, &base, "main")
            .await
            .unwrap();
        assert_eq!(ahead, 2, "merge commit + feature commit on main");
    }

    #[tokio::test]
    async fn merge_squash_collapses_feature_history() {
        let repo = TempRepo::new();
        let base = repo.head();
        let (state, ws_id) = setup(&repo);
        let wt = create(ws_id, "squashy", CreateOptions::default(), &state).await.unwrap().worktree;

        for (name, body) in [("a.txt", "a\n"), ("b.txt", "b\n"), ("c.txt", "c\n")] {
            std::fs::write(wt.path.join(name), body).unwrap();
            run_in(&wt.path, &["add", name]);
            run_in(&wt.path, &["commit", "-q", "-m", name]);
        }

        let r = merge(
            wt.id,
            MergeBackStrategy::Squash,
            Some("squashed three".into()),
            &state,
        )
        .await
        .unwrap();
        assert!(matches!(r, MergeResult::Clean));

        let ahead = super::git_ops::commits_ahead(&repo.root, &base, "main")
            .await
            .unwrap();
        assert_eq!(ahead, 1);
    }

    #[tokio::test]
    async fn merge_rebase_ff_yields_linear_history() {
        let repo = TempRepo::new();
        let base = repo.head();
        let (state, ws_id) = setup(&repo);
        let wt = create(ws_id, "linear", CreateOptions::default(), &state).await.unwrap().worktree;

        for (name, body) in [("a.txt", "a\n"), ("b.txt", "b\n")] {
            std::fs::write(wt.path.join(name), body).unwrap();
            run_in(&wt.path, &["add", name]);
            run_in(&wt.path, &["commit", "-q", "-m", name]);
        }

        let r = merge(wt.id, MergeBackStrategy::RebaseFf, None, &state)
            .await
            .unwrap();
        assert!(matches!(r, MergeResult::Clean));

        // No merge commit; main is exactly 2 ahead.
        let ahead = super::git_ops::commits_ahead(&repo.root, &base, "main")
            .await
            .unwrap();
        assert_eq!(ahead, 2);
        // And no `Merge:` parent lines on HEAD.
        let log = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo.root)
            .args(["log", "-1", "--pretty=%P"])
            .output()
            .unwrap();
        let parents = String::from_utf8(log.stdout).unwrap();
        assert_eq!(
            parents.split_whitespace().count(),
            1,
            "ff-only merge should leave HEAD with a single parent"
        );
    }

    #[tokio::test]
    async fn sync_reports_already_up_to_date_when_nothing_behind() {
        let repo = TempRepo::new();
        let (state, ws_id) = setup(&repo);
        let wt = create(ws_id, "fresh", CreateOptions::default(), &state).await.unwrap().worktree;
        let r = sync_with_default(wt.id, SyncStrategy::Rebase, &state)
            .await
            .unwrap();
        assert!(matches!(r, SyncResult::AlreadyUpToDate));
    }

    #[tokio::test]
    async fn sync_dirty_refuses_to_merge_over_uncommitted() {
        let repo = TempRepo::new();
        let (state, ws_id) = setup(&repo);
        let wt = create(ws_id, "dirty", CreateOptions::default(), &state).await.unwrap().worktree;
        // Advance main so worktree is behind by one commit.
        repo.commit_file("fromain.txt", "main advance\n", "main +1");
        // Leave uncommitted dirt in the worktree.
        std::fs::write(wt.path.join("scratch.txt"), "local noise\n").unwrap();

        let r = sync_with_default(wt.id, SyncStrategy::Merge, &state)
            .await
            .unwrap();
        assert!(matches!(r, SyncResult::Dirty));
    }

    #[tokio::test]
    async fn sync_rebase_advances_base_ref_to_default_head() {
        let repo = TempRepo::new();
        let (state, ws_id) = setup(&repo);
        let wt = create(ws_id, "sync-rb", CreateOptions::default(), &state).await.unwrap().worktree;
        let old_base = wt.base_ref.clone();

        // main advances.
        let new_main_head = repo.commit_file("u.txt", "u\n", "main advance");

        let r = sync_with_default(wt.id, SyncStrategy::Rebase, &state)
            .await
            .unwrap();
        assert!(matches!(r, SyncResult::Clean { .. }));

        // State updated.
        let after = state.worktrees.get(&wt.id).unwrap().clone();
        assert_ne!(after.base_ref, old_base);
        assert_eq!(after.base_ref, new_main_head);
    }

    #[tokio::test]
    async fn reconcile_adopts_orphan_worktree_under_convention_path() {
        let repo = TempRepo::new();
        let (state, ws_id) = setup(&repo);
        // Create a worktree through git directly, without going through
        // manager::create — simulate "already on disk from a previous run".
        let orphan_dir = super::git_ops::worktrees_root_for(&repo.root).join("orphan");
        std::fs::create_dir_all(orphan_dir.parent().unwrap()).unwrap();
        run_in(
            &repo.root,
            &[
                "worktree",
                "add",
                "-b",
                "agent/orphan",
                orphan_dir.to_str().unwrap(),
                "main",
            ],
        );

        reconcile(ws_id, &state).await.unwrap();

        let adopted = state
            .worktrees
            .iter()
            .find(|e| e.value().branch == "agent/orphan")
            .map(|e| e.value().clone());
        assert!(adopted.is_some(), "orphan worktree should be adopted");
    }

    fn run_in(root: &std::path::Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }
}
