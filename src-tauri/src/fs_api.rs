use std::path::{Path, PathBuf};

use serde::Serialize;
use ts_rs::TS;

use crate::state::AppState;
use crate::util::errors::{AppError, AppResult};
use crate::util::ids::WorktreeId;

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileContent {
    /// UTF-8 text if the file decodes cleanly. `None` for binary or invalid
    /// UTF-8 — the frontend renders a "binary file" placeholder in that case.
    pub text: Option<String>,
    pub size: u64,
    pub binary: bool,
}

/// Soft cap for in-memory file reads. Larger files are still returned but
/// the frontend is expected to handle pagination (not in MVP).
const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;

pub async fn read_worktree_file(
    worktree_id: WorktreeId,
    rel_path: &str,
    state: &AppState,
) -> AppResult<FileContent> {
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();

    let abs = resolve_sandboxed(&wt.path, rel_path)?;

    let meta = tokio::fs::metadata(&abs).await?;
    if !meta.is_file() {
        return Err(AppError::Unknown(format!("not a regular file: {rel_path}")));
    }
    let size = meta.len();
    if size > MAX_READ_BYTES {
        return Ok(FileContent {
            text: None,
            size,
            binary: false, // unknown; too big to sniff cheaply
        });
    }

    let bytes = tokio::fs::read(&abs).await?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileContent {
            text: Some(text),
            size,
            binary: false,
        }),
        Err(_) => Ok(FileContent {
            text: None,
            size,
            binary: true,
        }),
    }
}

/// Resolve `rel` relative to `root`, canonicalize, and reject any result that
/// escapes `root`. Prevents `../..` probes outside the worktree.
fn resolve_sandboxed(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let candidate = root.join(rel);
    let canon_root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let canon = dunce::canonicalize(&candidate)
        .map_err(|e| AppError::Io(format!("canonicalize {rel}: {e}")))?;
    if !canon.starts_with(&canon_root) {
        return Err(AppError::Unknown(format!("path escape: {rel}")));
    }
    Ok(canon)
}
