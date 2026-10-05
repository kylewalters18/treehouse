use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex as AsyncMutex;

use crate::agent::supervisor::AgentRegistry;
use crate::diff::DiffSet;
use crate::fs_watch::{WatchRegistry, WorkspaceWatchRegistry};
use crate::lsp::registry::LspRegistry;
use crate::mcp::McpRegistry;
use crate::pty::manager::TerminalRegistry;
use crate::scratch::ScratchState;
use crate::util::ids::{WorkspaceId, WorktreeId};
use crate::workspace::Workspace;
use crate::worktree::status::{MergeCheckCache, StatusCache};
use crate::worktree::Worktree;

/// Authoritative application state owned by the Rust main process.
pub struct AppState {
    pub workspaces: Arc<DashMap<WorkspaceId, Workspace>>,
    /// Mutate membership only via `register_worktree` / `unregister_worktree`
    /// so `worktree_paths` stays in sync.
    pub worktrees: Arc<DashMap<WorktreeId, Worktree>>,
    /// Canonical worktree dir → id. The uniqueness index behind `worktrees`:
    /// one directory can never hold two ids, even when `create` and the
    /// autodiscover `reconcile` race to register the same new dir.
    pub worktree_paths: Arc<DashMap<PathBuf, WorktreeId>>,
    pub diffs: Arc<DashMap<WorktreeId, DiffSet>>,
    pub watchers: Arc<WatchRegistry>,
    /// Watchers on each open workspace's `<repo>__worktrees/` root —
    /// surfaces worktrees created/removed outside treehouse.
    pub workspace_watchers: Arc<WorkspaceWatchRegistry>,
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
    /// Cached forge remote per workspace (parsed `origin` URL → host/owner/repo/kind).
    /// `None` means "detected, but no recognized forge" — cached so a local-only
    /// repo doesn't re-fork `git remote get-url` on every forge poll. Evicted in
    /// `close_workspace`.
    pub forge_remotes: Arc<DashMap<WorkspaceId, Option<crate::forge::RemoteInfo>>>,
    /// Treehouse MCP server: bound port + per-agent bearer tokens.
    pub mcp: Arc<McpRegistry>,
    /// The global ⌘J scratch agent — see `crate::scratch`.
    pub scratch: Arc<ScratchState>,
    /// Per-repo ⌘J planners — see `crate::planner`.
    pub planners: Arc<crate::planner::Planners>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            workspaces: Arc::new(DashMap::new()),
            worktrees: Arc::new(DashMap::new()),
            worktree_paths: Arc::new(DashMap::new()),
            diffs: Arc::new(DashMap::new()),
            watchers: Arc::new(WatchRegistry::new()),
            workspace_watchers: Arc::new(WorkspaceWatchRegistry::new()),
            terminals: Arc::new(TerminalRegistry::new()),
            agents: Arc::new(AgentRegistry::new()),
            lsp: Arc::new(LspRegistry::new()),
            merge_lock: Arc::new(AsyncMutex::new(())),
            worktree_status: Arc::new(DashMap::new()),
            merge_check_cache: Arc::new(DashMap::new()),
            forge_remotes: Arc::new(DashMap::new()),
            mcp: Arc::new(McpRegistry::new()),
            scratch: Arc::new(ScratchState::new()),
            planners: Arc::new(crate::planner::Planners::default()),
        }
    }

    /// Insert `wt` keyed by its directory. If that dir is already registered
    /// the existing id wins: with `refresh` the stored entry takes `wt`'s
    /// fields (under the existing id), otherwise it's left untouched. Returns
    /// the stored worktree and whether it was newly inserted.
    ///
    /// The path-index entry guard is held across the `worktrees` insert, so
    /// concurrent registrations of one dir serialize on it.
    pub fn register_worktree(&self, mut wt: Worktree, refresh: bool) -> (Worktree, bool) {
        match self.worktree_paths.entry(canonical(&wt.path)) {
            Entry::Occupied(mut e) => {
                let id = *e.get();
                if let Some(mut existing) = self.worktrees.get_mut(&id) {
                    if refresh {
                        wt.id = id;
                        *existing = wt;
                    }
                    return (existing.clone(), false);
                }
                // Stale index entry (its worktree was just unregistered) —
                // reclaim the slot.
                e.insert(wt.id);
                self.worktrees.insert(wt.id, wt.clone());
            }
            Entry::Vacant(e) => {
                let _guard = e.insert(wt.id);
                self.worktrees.insert(wt.id, wt.clone());
            }
        }
        (wt, true)
    }

    /// Drop a worktree and its path-index entry.
    pub fn unregister_worktree(&self, id: &WorktreeId) -> Option<Worktree> {
        let removed = self.worktrees.remove(id).map(|(_, wt)| wt);
        // Match by id, not path: a vanished dir no longer canonicalizes to
        // the key it was registered under.
        self.worktree_paths.retain(|_, v| v != id);
        removed
    }
}

fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
