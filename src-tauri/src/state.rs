use dashmap::DashMap;
use std::sync::Arc;

use tokio::sync::Mutex as AsyncMutex;

use crate::agent::supervisor::AgentRegistry;
use crate::diff::DiffSet;
use crate::fs_watch::WatchRegistry;
use crate::lsp::registry::LspRegistry;
use crate::pty::manager::TerminalRegistry;
use crate::util::ids::{WorkspaceId, WorktreeId};
use crate::workspace::Workspace;
use crate::worktree::Worktree;

/// Authoritative application state owned by the Rust main process.
pub struct AppState {
    pub workspaces: Arc<DashMap<WorkspaceId, Workspace>>,
    pub worktrees: Arc<DashMap<WorktreeId, Worktree>>,
    pub diffs: Arc<DashMap<WorktreeId, DiffSet>>,
    pub watchers: Arc<WatchRegistry>,
    pub terminals: Arc<TerminalRegistry>,
    pub agents: Arc<AgentRegistry>,
    pub lsp: Arc<LspRegistry>,
    /// Serialized merge-back across worktrees (single-process scope is fine).
    pub merge_lock: Arc<AsyncMutex<()>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            workspaces: Arc::new(DashMap::new()),
            worktrees: Arc::new(DashMap::new()),
            diffs: Arc::new(DashMap::new()),
            watchers: Arc::new(WatchRegistry::new()),
            terminals: Arc::new(TerminalRegistry::new()),
            agents: Arc::new(AgentRegistry::new()),
            lsp: Arc::new(LspRegistry::new()),
            merge_lock: Arc::new(AsyncMutex::new(())),
        }
    }
}
