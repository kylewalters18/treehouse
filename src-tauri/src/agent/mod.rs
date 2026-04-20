pub mod supervisor;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::util::ids::{AgentSessionId, WorktreeId};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AgentBackendKind {
    ClaudeCode,
    Codex,
    Aider,
    GenericCli,
}

impl AgentBackendKind {
    pub fn default_argv(self) -> Vec<String> {
        match self {
            AgentBackendKind::ClaudeCode => vec!["claude".to_string()],
            AgentBackendKind::Codex => vec!["codex".to_string()],
            AgentBackendKind::Aider => vec!["aider".to_string()],
            AgentBackendKind::GenericCli => Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum AgentStatus {
    Starting,
    Running,
    Exited { code: Option<i32> },
    Crashed { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentSession {
    pub id: AgentSessionId,
    pub worktree_id: WorktreeId,
    pub backend: AgentBackendKind,
    pub argv: Vec<String>,
    /// Unix epoch milliseconds.
    pub started_at: u64,
    pub cols: u16,
    pub rows: u16,
    pub status: AgentStatus,
}

/// Streamed over a per-session Tauri Channel returned from `launch_agent`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum AgentEvent {
    Data { bytes: Vec<u8> },
    Status { status: AgentStatus },
}
