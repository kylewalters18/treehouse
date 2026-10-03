//! Typed event names emitted from Rust to the frontend.
//!
//! Conventions:
//! - Use `scope://{id}/what` as the event name.
//! - Payloads are serde-serializable structs (kept inline where small).

use crate::util::ids::{WorkspaceId, WorktreeId};

pub fn worktrees_changed(workspace_id: WorkspaceId) -> String {
    format!("workspace://{workspace_id}/worktrees-changed")
}

pub fn diff_updated(worktree_id: WorktreeId) -> String {
    format!("diff://{worktree_id}/updated")
}

pub fn lsp_servers_changed(workspace_id: WorkspaceId) -> String {
    format!("workspace://{workspace_id}/lsp-servers-changed")
}

/// Step transitions inside `worktree::manager::create`. Payload is a
/// short human-readable string ("Fetching from origin", etc.); the
/// frontend renders it verbatim in the create spinner so the user can
/// see what's currently slow.
pub fn worktree_create_step(workspace_id: WorkspaceId) -> String {
    format!("workspace://{workspace_id}/worktree-create-step")
}

/// The worktree → issue link map changed (any workspace). No payload; the
/// renderer reloads the map. Global because links are keyed by path.
pub fn issue_links_changed() -> String {
    "issue-links://changed".to_string()
}

/// An MR/PR was created (or otherwise changed) for a branch in this
/// workspace — by the UI or by an agent over MCP. Payload: the branch name.
pub fn mr_changed(workspace_id: WorkspaceId) -> String {
    format!("workspace://{workspace_id}/mr-changed")
}
