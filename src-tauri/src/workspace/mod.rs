mod repo;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use ts_rs::TS;

use crate::state::AppState;
use crate::util::errors::{AppError, AppResult};
use crate::util::ids::WorkspaceId;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Workspace {
    pub id: WorkspaceId,
    #[ts(type = "string")]
    pub root: PathBuf,
    pub default_branch: String,
}

pub async fn open(path: &str, state: &AppState) -> AppResult<Workspace> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(AppError::PathNotFound(path.display().to_string()));
    }

    let root = repo::discover_root(&path)?;

    // Webview reloads (⌘R) don't restart the Rust process, so the workspace
    // may already be registered from a previous page load. Rather than
    // erroring with AlreadyOpen, hand back the existing entry — downstream
    // reconcile/register/prime steps are all idempotent, so re-running them
    // on the same workspace is a no-op.
    if let Some(existing) = state
        .workspaces
        .iter()
        .find(|entry| entry.value().root == root)
    {
        return Ok(existing.value().clone());
    }

    let default_branch = repo::detect_default_branch(&root)?;

    let workspace = Workspace {
        id: WorkspaceId::new(),
        root,
        default_branch,
    };

    state.workspaces.insert(workspace.id, workspace.clone());
    tracing::info!(id = %workspace.id, root = %workspace.root.display(), "opened workspace");
    Ok(workspace)
}
