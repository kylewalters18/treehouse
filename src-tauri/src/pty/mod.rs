pub mod manager;
pub mod shell_integration;
pub mod text;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::util::ids::{TerminalId, WorktreeId};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalSession {
    pub id: TerminalId,
    pub worktree_id: WorktreeId,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
}

/// The command a terminal is running, or the last one it ran, as reported
/// by shell integration (see [`shell_integration`]). Shells without it
/// never produce one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalCommand {
    pub terminal_id: TerminalId,
    /// The command line as typed.
    pub command: String,
    /// Unix epoch ms.
    #[ts(type = "number")]
    pub started_at: u64,
    /// `None` while it's still running.
    #[ts(type = "number | null")]
    pub finished_at: Option<u64>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum PtyEvent {
    Data {
        /// Raw PTY output bytes. Serialized as a JSON number array over the
        /// Tauri Channel. Normal shell volumes are fine; if this becomes
        /// a hotspot for long agent output, swap to base64 or Tauri's binary
        /// channel mode.
        bytes: Vec<u8>,
    },
    Exit {
        code: Option<i32>,
    },
}
