pub mod git_ops;
pub mod manager;
pub mod status;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use ts_rs::TS;

use crate::util::ids::{WorkspaceId, WorktreeId};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Worktree {
    pub id: WorktreeId,
    pub workspace_id: WorkspaceId,
    #[ts(type = "string")]
    pub path: PathBuf,
    pub branch: String,
    pub base_ref: String,
    pub head: String,
    pub dirty: bool,
    /// The main repository's own workdir — not a true worktree. Rendered at
    /// the top of the sidebar with a distinct style; launch / merge /
    /// remove are all refused for this entry.
    pub is_main_clone: bool,
}

pub use manager::{
    create, list_for_workspace, merge, reconcile, register_main_clone, remove,
    sync_with_default, CreateOptions, CreateWorktreeResult, MergeBackStrategy,
    MergeResult, SyncResult, SyncStrategy,
};
