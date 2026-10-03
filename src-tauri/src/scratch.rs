//! The scratch agent: one global session of the user's default agent that
//! isn't tied to any repo, shown in a ⌘J popup over whatever the user is
//! looking at. It runs in a scratch directory under the app config dir. When
//! it's Claude Code it gets the treehouse MCP server like any other Claude
//! launch — scoped as `CallerScope::Scratch`, so it can `list_repos` and
//! create worktrees in any open workspace. Other backends get no MCP (same as
//! in worktrees).
//!
//! It lives in the ordinary `AgentRegistry` (ring buffer, attach, hooks,
//! shutdown `kill_all` all come free) under a synthetic `WorktreeId` that is
//! never inserted into `AppState::worktrees`. Every per-worktree view — the
//! sidebar activity, the agent board — filters through that map, so the
//! scratch session stays out of them without special cases.

use parking_lot::Mutex;
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::agent::supervisor::{self, AgentRegistry};
use crate::agent::{AgentActivity, AgentEvent, AgentSession};
use crate::storage;
use crate::util::errors::{AppError, AppResult};
use crate::util::ids::{AgentSessionId, WorktreeId};

/// Recorded as `Worktree::created_by` for worktrees the scratch agent
/// creates, so the sidebar shows `↳ scratch`.
pub const CREATED_BY: &str = "scratch";

pub struct ScratchState {
    /// Synthetic owner id for the scratch session. Fresh per app run.
    pub worktree_id: WorktreeId,
    agent: Mutex<Option<AgentSessionId>>,
}

impl ScratchState {
    pub fn new() -> Self {
        Self {
            worktree_id: WorktreeId::new(),
            agent: Mutex::new(None),
        }
    }

    /// Hook-derived activity of the scratch session (Inactive if none).
    pub fn activity(&self, agents: &AgentRegistry) -> AgentActivity {
        agents.activity_for_worktree(self.worktree_id)
    }
}

/// The scratch agent's working dir. Stable, so its past conversations
/// can be listed and resumed (Claude resumes only in the same directory).
pub fn dir(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    Ok(storage::config_dir(app)?.join("scratch"))
}

/// Attach `channel` to the running scratch session, or start one if there
/// isn't a live one. Either way the caller gets output from the start: a new
/// session streams straight into `channel`, an existing one replays its ring
/// buffer first. With `resume`, the running session is replaced by that
/// past conversation.
pub async fn open(
    app: &AppHandle,
    scratch: &ScratchState,
    agents: &AgentRegistry,
    resume: Option<String>,
    cols: u16,
    rows: u16,
    channel: Channel<AgentEvent>,
) -> AppResult<AgentSession> {
    let existing = *scratch.agent.lock();
    if let Some(id) = existing.filter(|id| supervisor::is_live(agents, *id)) {
        if resume.is_none() {
            return supervisor::attach(agents, id, channel);
        }
        supervisor::kill_for_worktree(agents, scratch.worktree_id);
    }

    let cwd = dir(app)?;
    std::fs::create_dir_all(&cwd)
        .map_err(|e| AppError::Unknown(format!("create scratch dir: {e}")))?;
    let settings = storage::load_settings(app).await.unwrap_or_default();
    let backend = settings.default_agent_backend;
    let argv = crate::mcp::split_command(settings.agent_commands.for_backend(backend));

    let session = supervisor::launch(
        app,
        agents,
        scratch.worktree_id,
        cwd,
        backend,
        Some(argv),
        None,
        resume,
        cols,
        rows,
        Some(channel),
    )?;
    *scratch.agent.lock() = Some(session.id);
    Ok(session)
}
