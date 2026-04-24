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
use crate::worktree::status::{MergeCheckCache, StatusCache};
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
    /// Event-driven cache of ahead/behind/dirty/merged per worktree.
    /// Populated by `worktree::status::recompute` at create, fs-watch
    /// events, sync, merge; read by `list_agent_activity`.
    pub worktree_status: StatusCache,
    /// Memoizes `effectively_merged` by `(branch_head_sha, base_head_sha)`
    /// so event bursts that don't move HEAD don't redo the merge-tree call.
    pub merge_check_cache: MergeCheckCache,
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
            worktree_status: Arc::new(DashMap::new()),
            merge_check_cache: Arc::new(DashMap::new()),
        }
    }
}
