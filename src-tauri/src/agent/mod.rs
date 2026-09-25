pub mod hooks;
pub mod patterns;
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
    Kiro,
}

impl AgentBackendKind {
    pub fn default_argv(self) -> Vec<String> {
        match self {
            AgentBackendKind::ClaudeCode => vec!["claude".to_string()],
            AgentBackendKind::Codex => vec!["codex".to_string()],
            AgentBackendKind::Kiro => vec!["kiro-cli".to_string()],
        }
    }

    /// Whether `<cli> -- "<prompt>"` starts an interactive session with that
    /// prompt already submitted. Kiro's equivalent is unverified.
    pub fn accepts_positional_prompt(self) -> bool {
        matches!(self, AgentBackendKind::ClaudeCode | AgentBackendKind::Codex)
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

/// One named agent (sub-agent profile / context) the user can pre-select
/// when launching. Discovered by shelling out to the backend's CLI:
/// `claude agents list` or `kiro-cli agent list`. Codex has no analog.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackendAgent {
    pub name: String,
}

/// Streamed over a per-session Tauri Channel returned from `launch_agent`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum AgentEvent {
    Data { bytes: Vec<u8> },
    Status { status: AgentStatus },
}

/// Coarse activity classification: Claude Code hook events when present,
/// else time-since-last-output. The sidebar polls `list_agent_activity`
/// every ~1.5s and paints a dot.
#[derive(Debug, Clone, Copy, Serialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AgentActivity {
    /// No agent session exists for the worktree.
    Inactive,
    /// Producing output now.
    Working,
    /// Briefly quiet — rendering or thinking.
    Idle,
    /// Quiet long enough that the agent is almost certainly awaiting input.
    NeedsAttention,
}

/// What a blocked agent is waiting on, as reported by Claude Code hooks.
#[derive(Debug, Clone, Serialize, TS, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum PendingPrompt {
    /// A tool-permission dialog is on screen. `detail` is the command,
    /// path, or URL the tool would act on, when there is one.
    Permission {
        #[serde(rename = "toolName")]
        tool_name: String,
        detail: Option<String>,
    },
    /// Anything else the agent is blocked on (a question, a dialog).
    Input { message: Option<String> },
}

/// One agent session as the agent board shows it. Polled while the board
/// is open; everything here is read from in-memory state.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentOverview {
    pub session: AgentSession,
    pub activity: AgentActivity,
    /// Unix epoch ms of the last activity change — the start of the
    /// current state, not the last byte of output.
    #[ts(type = "number")]
    pub changed_at: u64,
    /// First line of the most recent prompt sent to the agent.
    pub task: Option<String>,
    /// Most recent tool call, e.g. `Bash: cargo test`.
    pub current_tool: Option<String>,
    /// The agent's final message from its last finished turn.
    pub last_message: Option<String>,
    pub pending: Option<PendingPrompt>,
    /// `pending` is a permission dialog nobody has typed into since it
    /// appeared, so allow/deny can be answered from the board.
    pub can_answer_inline: bool,
    /// Branch diff stats for the session's worktree, from the diff cache.
    pub diff_stats: Option<crate::diff::DiffStats>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorktreeActivity {
    pub worktree_id: crate::util::ids::WorktreeId,
    pub activity: AgentActivity,
    /// Live agent sessions in the worktree. `activity` is the most
    /// alerting state across all of them.
    pub agent_count: u32,
    /// Commits on the worktree's branch not on the workspace's default branch.
    pub ahead: u32,
    /// Commits on the default branch not on the worktree's branch.
    pub behind: u32,
    /// `git status --porcelain` returned anything: tracked or untracked
    /// changes exist in the worktree's workdir.
    pub dirty: bool,
    /// Branch's work is already represented on default (via merge, squash,
    /// rebase, etc.) — detected by tree equality from `git merge-tree`.
    /// Lets the sidebar drop squash-merged worktrees into "Inactive"
    /// instead of stranding them under "Changes" forever.
    pub merged: bool,
}
