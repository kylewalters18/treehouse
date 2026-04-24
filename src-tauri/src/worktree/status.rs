//! Cached per-worktree git status (`ahead` / `behind` / `dirty` / `merged`).
//!
//! Replaces per-poll shell-outs with a recompute-on-change model: the
//! frontend's activity poll reads from the cache in memory, and git calls
//! only fire at discrete events — worktree create, fs watcher flushes,
//! explicit sync / merge, or `recompute_all` seeding at startup.

use std::sync::Arc;

use dashmap::DashMap;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use ts_rs::TS;

use crate::state::AppState;
use crate::util::ids::WorktreeId;
use crate::worktree::git_ops;

/// What the sidebar actually needs per worktree. Stored in
/// `AppState::worktree_status` under the worktree's id.
#[derive(Debug, Clone, Copy, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorktreeStatus {
    /// Commits on this worktree's branch not on the workspace's default
    /// branch (or `origin/<default>` when local is stale).
    pub ahead: u32,
    /// Commits on default not on this worktree's branch.
    pub behind: u32,
    /// `git status --porcelain` returned anything — tracked or untracked
    /// changes exist in the workdir.
    pub dirty: bool,
    /// Branch's work is already represented on default (merge-tree equality).
    /// Catches squash-merges that `ahead` alone can't see.
    pub merged: bool,
}

impl Default for WorktreeStatus {
    fn default() -> Self {
        Self {
            ahead: 0,
            behind: 0,
            dirty: false,
            merged: false,
        }
    }
}

pub type StatusCache = Arc<DashMap<WorktreeId, WorktreeStatus>>;

/// Cache for `effectively_merged` keyed by `(branch_head_sha, base_head_sha)`.
/// merge-tree is the most expensive call in recompute; memoizing it lets
/// bursts of fs events (which don't move HEAD) skip the work.
pub type MergeCheckCache = Arc<DashMap<(String, String), bool>>;

/// Recompute a single worktree's status and drop it into the cache. Returns
/// the new value so callers that need it don't have to look it back up.
/// Non-fatal: any git error falls back to a `Default::default()` row and is
/// logged — missing status is better than a hard failure propagating into
/// unrelated flows.
pub async fn recompute(app: &AppHandle, worktree_id: WorktreeId) -> WorktreeStatus {
    let state = app.state::<AppState>();
    let (repo_root, default_branch, branch, path, is_main_clone) = {
        let wt = match state.worktrees.get(&worktree_id) {
            Some(e) => e.value().clone(),
            None => return WorktreeStatus::default(),
        };
        let ws = match state.workspaces.get(&wt.workspace_id) {
            Some(e) => e.value().clone(),
            None => return WorktreeStatus::default(),
        };
        (ws.root, ws.default_branch, wt.branch, wt.path, wt.is_main_clone)
    };

    if is_main_clone {
        // Main-clone entries show no ahead/behind/merged — they are the
        // reference point. `dirty` we still surface so the user can see if
        // they've got uncommitted edits in the main repo itself.
        let dirty = git_ops::has_changes(&path).await.unwrap_or(false);
        let status = WorktreeStatus {
            ahead: 0,
            behind: 0,
            dirty,
            merged: false,
        };
        state.worktree_status.insert(worktree_id, status);
        return status;
    }

    // Pick origin/<default> over local <default> when local is stale —
    // saves users from inflated ahead counts after forgetting to pull.
    let base = git_ops::resolve_default_base(&repo_root, &default_branch).await;

    let ab_result = git_ops::ahead_behind(&repo_root, &base, &branch).await;
    let (ahead, behind, ab_ok) = match &ab_result {
        Ok(v) => (v.0, v.1, true),
        Err(e) => {
            tracing::warn!(%worktree_id, %branch, %base, ?e, "ahead_behind failed");
            (0, 0, false)
        }
    };
    let dirty = git_ops::has_changes(&path).await.unwrap_or(false);

    // `merged` is tree-equality via merge-tree — catches squash merges
    // that SHA-based `ahead` can't see. Short-circuit to `true` only when
    // ahead is *genuinely* zero (rev-list reported 0, not defaulted after
    // an error). If we don't know, default to false — false positives here
    // hide worktrees in "Inactive" when they shouldn't be.
    let merged = if !ab_ok {
        false
    } else if ahead == 0 {
        true
    } else {
        let branch_sha = git_ops::rev_parse(&repo_root, &branch)
            .await
            .unwrap_or_default();
        let base_sha = git_ops::rev_parse(&repo_root, &base)
            .await
            .unwrap_or_default();
        if branch_sha.is_empty() || base_sha.is_empty() {
            false
        } else {
            let key = (branch_sha, base_sha);
            if let Some(cached) = state.merge_check_cache.get(&key) {
                *cached.value()
            } else {
                match git_ops::effectively_merged(&repo_root, &base, &branch).await {
                    Ok(m) => {
                        state.merge_check_cache.insert(key, m);
                        m
                    }
                    Err(e) => {
                        tracing::warn!(
                            %worktree_id, %branch, %base, ?e,
                            "effectively_merged failed"
                        );
                        false
                    }
                }
            }
        }
    };

    let status = WorktreeStatus {
        ahead,
        behind,
        dirty,
        merged,
    };
    tracing::debug!(
        %worktree_id, %branch, %base,
        ahead, behind, dirty, merged,
        "recomputed worktree status"
    );
    state.worktree_status.insert(worktree_id, status);
    status
}

/// Seed the cache for every worktree in a workspace. Called after
/// `open_workspace` reconciles pre-existing worktrees so the first
/// sidebar render isn't empty.
pub async fn recompute_all_for_workspace(
    app: &AppHandle,
    workspace_id: crate::util::ids::WorkspaceId,
) {
    let ids: Vec<WorktreeId> = app
        .state::<AppState>()
        .worktrees
        .iter()
        .filter(|e| e.value().workspace_id == workspace_id)
        .map(|e| *e.key())
        .collect();
    for id in ids {
        let _ = recompute(app, id).await;
    }
}

/// Best-effort: schedule a recompute without waiting. Used from the
/// fs_watch callback (which runs on the notify watcher thread and can't
/// easily await).
pub fn spawn_recompute(app: &AppHandle, worktree_id: WorktreeId) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        recompute(&app, worktree_id).await;
    });
}

/// Drop cache entries for a removed worktree.
pub fn drop_for(state: &AppState, worktree_id: WorktreeId) {
    state.worktree_status.remove(&worktree_id);
}
