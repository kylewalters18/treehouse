pub mod manager;

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
