use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::state::AppState;
use crate::util::errors::{AppError, AppResult};
use crate::util::ids::{WorkspaceId, WorktreeId};

use super::{git_ops, Worktree};

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
    /// Main repo is not on the default branch; user must check it out first.
    WrongBranch { current: String, expected: String },
}

/// Create a new worktree under `<repo>__worktrees/<slug>/` on branch `agent/<slug>`.
/// `name` is a friendly label; it's slugified into the path + branch.
pub async fn create(
    workspace_id: WorkspaceId,
    name: &str,
    state: &AppState,
) -> AppResult<Worktree> {
    let ws = state
        .workspaces
        .get(&workspace_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {workspace_id}")))?
        .clone();

    let slug = git_ops::slugify(name);
    let branch = format!("agent/{slug}");
    let root = git_ops::worktrees_root_for(&ws.root);
    let path: PathBuf = root.join(&slug);

    if path.exists() {
        return Err(AppError::AlreadyOpen(format!("worktree dir exists: {}", path.display())));
    }
    if git_ops::branch_exists(&ws.root, &branch).await? {
        return Err(AppError::AlreadyOpen(format!("branch exists: {branch}")));
    }
    tokio::fs::create_dir_all(&root).await?;

    let base_ref = ws.default_branch.clone();
    let base_sha = git_ops::rev_parse(&ws.root, &base_ref).await?;
    git_ops::add(&ws.root, &path, &branch, &base_ref).await?;

    let worktree = Worktree {
        id: WorktreeId::new(),
        workspace_id,
        path,
        branch,
        base_ref: base_sha.clone(),
        head: base_sha,
        dirty: false,
        is_main_clone: false,
    };
    state.worktrees.insert(worktree.id, worktree.clone());
    tracing::info!(id = %worktree.id, path = %worktree.path.display(), "created worktree");
    Ok(worktree)
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
    squash: bool,
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
    // Tell the user — and if they have uncommitted changes in the worktree,
    // point them at that so they can commit themselves.
    let ahead = git_ops::commits_ahead(&ws.root, &ws.default_branch, &wt.branch).await?;
    if ahead == 0 {
        let dirty = git_ops::has_changes(&wt.path).await.unwrap_or(false);
        return Ok(MergeResult::NothingToMerge {
            uncommitted_changes: dirty,
        });
    }

    let merge_result = if squash {
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
    } else {
        git_ops::merge_no_ff(&ws.root, &wt.branch).await
    };

    match merge_result {
        Ok(()) => {
            tracing::info!(
                id = %worktree_id,
                branch = %wt.branch,
                squash,
                "merged worktree"
            );
            Ok(MergeResult::Clean)
        }
        Err(AppError::GitError(msg)) => {
            // Leave the conflict visible in the main repo's workdir for the
            // user to resolve in their own terminal — don't auto-abort.
            tracing::warn!(id = %worktree_id, %msg, "merge produced conflicts");
            Ok(MergeResult::Conflict { message: msg })
        }
        Err(e) => Err(e),
    }
}

pub fn list_for_workspace(workspace_id: WorkspaceId, state: &AppState) -> Vec<Worktree> {
    state
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
        .collect()
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
    let entries = git_ops::list(&ws.root).await?;

    let existing_paths: std::collections::HashSet<PathBuf> = state
        .worktrees
        .iter()
        .filter(|e| e.value().workspace_id == workspace_id)
        .map(|e| e.value().path.clone())
        .collect();

    for entry in entries {
        if !entry.path.starts_with(&root) {
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
