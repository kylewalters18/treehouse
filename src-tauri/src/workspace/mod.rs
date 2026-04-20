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

    // Prevent re-opening the same repo twice.
    if let Some(existing) = state
        .workspaces
        .iter()
        .find(|entry| entry.value().root == root)
    {
        return Err(AppError::AlreadyOpen(existing.value().root.display().to_string()));
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
