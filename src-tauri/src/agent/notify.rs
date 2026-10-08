//! Push "some agent's activity changed" to the renderer, so the sidebar
//! dot, agent board and planner pill update the moment an ACP turn starts,
//! a permission is requested, a Claude hook fires, a session exits, or a
//! worktree's git state (dirty / ahead / merged) changes —
//! rather than on their next poll. Bursts coalesce into one event; the
//! payload is empty and listeners refetch (`list_agent_activity`, …).
//!
//! Their polls stay as a slow fallback for the few time-driven changes: a
//! Claude permission prompt expiring after it's been typed into (see
//! `session_activity`), and the board's relative times.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();
static PENDING: AtomicBool = AtomicBool::new(false);
const COALESCE: Duration = Duration::from_millis(50);

/// Called once at startup; before it (and in tests) notifications no-op.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

pub fn activity_changed() {
    let Some(app) = APP.get() else { return };
    if PENDING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(COALESCE).await;
        PENDING.store(false, Ordering::Release);
        let _ = app.emit(crate::ipc::events::AGENT_ACTIVITY_CHANGED, ());
    });
}
