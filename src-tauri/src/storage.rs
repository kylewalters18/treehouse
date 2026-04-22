//! Tiny JSON-on-disk persistence. Currently holds the list of recently-
//! opened workspaces so the Home screen can one-click back into them.
//!
//! Location: `<app-config-dir>/recent.json`, resolved via Tauri's path API.
//! On macOS that's `~/Library/Application Support/com.treehouse.app/`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use ts_rs::TS;

use crate::util::errors::{AppError, AppResult};
use crate::worktree::{MergeBackStrategy, SyncStrategy};

const RECENT_MAX: usize = 20;
const RECENT_FILE: &str = "recent.json";
const SETTINGS_FILE: &str = "settings.json";
const COMMENTS_FILE: &str = "comments.json";

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecentWorkspace {
    #[ts(type = "string")]
    pub path: PathBuf,
    /// Unix epoch milliseconds of the most recent open.
    pub last_opened_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RecentFile {
    items: Vec<RecentWorkspace>,
}

fn config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| AppError::Unknown(format!("config dir: {e}")))
}

fn recent_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(config_dir(app)?.join(RECENT_FILE))
}

pub async fn list_recent(app: &AppHandle) -> AppResult<Vec<RecentWorkspace>> {
    let path = recent_path(app)?;
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(format!("read {}: {e}", path.display()))),
    };
    let file: RecentFile = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::Unknown(format!("parse {}: {e}", path.display())))?;

    // Drop any entries whose path no longer exists — keeps the Home list from
    // accumulating dead references if you move repos around.
    let mut filtered: Vec<RecentWorkspace> = Vec::with_capacity(file.items.len());
    for item in file.items {
        if tokio::fs::metadata(&item.path).await.is_ok() {
            filtered.push(item);
        }
    }
    Ok(filtered)
}

pub async fn push_recent(app: &AppHandle, opened_path: &PathBuf) -> AppResult<()> {
    let dir = config_dir(app)?;
    let _ = tokio::fs::create_dir_all(&dir).await;
    let path = recent_path(app)?;

    let mut items = match list_recent(app).await {
        Ok(v) => v,
        Err(_) => Vec::new(),
    };
    items.retain(|w| w.path != *opened_path);
    items.insert(
        0,
        RecentWorkspace {
            path: opened_path.clone(),
            last_opened_at: now_millis(),
        },
    );
    if items.len() > RECENT_MAX {
        items.truncate(RECENT_MAX);
    }

    let file = RecentFile { items };
    let bytes = serde_json::to_vec_pretty(&file)
        .map_err(|e| AppError::Unknown(format!("serialize recent: {e}")))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| AppError::Io(format!("write {}: {e}", path.display())))?;
    Ok(())
}

fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// --- Settings ---

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Settings {
    /// Default strategy when the user clicks Sync. Defaults to Rebase
    /// (linear agent-branch history; auto-aborts on conflict).
    pub sync_strategy: SyncStrategy,
    /// Default strategy preselected in the Merge dialog. Defaults to
    /// RebaseFf (rebase agent branch + ff-only merge — linear history).
    pub merge_back_strategy: MergeBackStrategy,
    /// UI zoom factor applied via `document.documentElement.style.zoom`
    /// on the frontend. 1.0 = default. Clamped to [0.5, 2.0] on the
    /// frontend; we persist whatever the user lands on.
    pub zoom: f32,
    /// When true, run `git submodule update --init --recursive` on the
    /// new worktree after creation. Off by default — most repos don't have
    /// submodules and the extra git invocation just slows create down.
    pub init_submodules: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sync_strategy: SyncStrategy::default(),
            merge_back_strategy: MergeBackStrategy::default(),
            zoom: 1.0,
            init_submodules: false,
        }
    }
}

fn settings_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(config_dir(app)?.join(SETTINGS_FILE))
}

pub async fn load_settings(app: &AppHandle) -> AppResult<Settings> {
    let path = settings_path(app)?;
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Settings::default())
        }
        Err(e) => return Err(AppError::Io(format!("read {}: {e}", path.display()))),
    };
    // Tolerant: bad JSON falls back to defaults instead of bricking the app.
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

pub async fn save_settings(app: &AppHandle, settings: &Settings) -> AppResult<()> {
    let dir = config_dir(app)?;
    let _ = tokio::fs::create_dir_all(&dir).await;
    let path = settings_path(app)?;
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|e| AppError::Unknown(format!("serialize settings: {e}")))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| AppError::Io(format!("write {}: {e}", path.display())))?;
    Ok(())
}

// --- Review comments ---

/// One reviewer comment anchored to a (workspace_root, branch, file, line).
/// Stored as a flat list across all workspaces; frontend filters by the
/// pair `(workspace_root, branch)` since worktree IDs are ephemeral
/// across app restarts.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Comment {
    pub id: String,
    pub workspace_root: String,
    pub branch: String,
    pub file_path: String,
    pub line: u32,
    pub text: String,
    /// Epoch milliseconds. Fits in `Number.MAX_SAFE_INTEGER` for the next
    /// ~285k years, so ts-rs is overridden to surface it as `number` rather
    /// than `bigint` — BigInt args can't be sent over Tauri's IPC (which
    /// `JSON.stringify`s arguments).
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number | null")]
    pub resolved_at: Option<u64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CommentsFile {
    items: Vec<Comment>,
}

fn comments_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(config_dir(app)?.join(COMMENTS_FILE))
}

pub async fn load_comments(app: &AppHandle) -> AppResult<Vec<Comment>> {
    let path = comments_path(app)?;
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(format!("read {}: {e}", path.display()))),
    };
    let file: CommentsFile = serde_json::from_slice(&bytes).unwrap_or_default();
    Ok(file.items)
}

pub async fn save_comments(app: &AppHandle, items: &[Comment]) -> AppResult<()> {
    let dir = config_dir(app)?;
    let _ = tokio::fs::create_dir_all(&dir).await;
    let path = comments_path(app)?;
    let file = CommentsFile {
        items: items.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&file)
        .map_err(|e| AppError::Unknown(format!("serialize comments: {e}")))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| AppError::Io(format!("write {}: {e}", path.display())))?;
    Ok(())
}
