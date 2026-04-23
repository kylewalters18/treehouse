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
