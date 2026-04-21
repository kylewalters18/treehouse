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

const RECENT_MAX: usize = 20;
const RECENT_FILE: &str = "recent.json";

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
