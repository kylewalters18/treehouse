pub mod git_ops;
pub mod manager;

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
}

pub use manager::{create, list_for_workspace, merge, reconcile, remove, MergeResult};
