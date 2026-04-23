use std::process::{Child, ChildStdin};
use std::sync::Arc;

use dashmap::DashMap;
use parking_lot::Mutex;
use tauri::ipc::Channel;

use crate::util::ids::{LspServerId, WorktreeId};

use super::{LspEvent, LspServerSession, LspServerStatus};

/// Per-server state touched by reader threads and command handlers. The
/// attached `channel` may be swapped by `attach` when the renderer reopens
/// the editor for a worktree.
pub struct LspShared {
    pub channel: Option<Channel<LspEvent>>,
    pub status: LspServerStatus,
}

pub struct LspHandle {
    pub session: LspServerSession,
    /// `None` after the server has been killed — reject subsequent writes.
    pub writer: Arc<Mutex<Option<ChildStdin>>>,
    pub child: Arc<Mutex<Child>>,
    pub shared: Arc<Mutex<LspShared>>,
}

#[derive(Default)]
pub struct LspRegistry {
    pub(super) inner: DashMap<LspServerId, LspHandle>,
}

impl LspRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self) -> Vec<LspServerSession> {
        let mut out: Vec<LspServerSession> = self
            .inner
            .iter()
            .map(|e| e.value().session.clone())
            .collect();
        out.sort_by_key(|s| s.started_at);
        out
    }

    pub fn list_for_worktree(&self, worktree_id: WorktreeId) -> Vec<LspServerSession> {
        let mut out: Vec<LspServerSession> = self
            .inner
            .iter()
            .filter(|e| e.value().session.worktree_id == worktree_id)
            .map(|e| e.value().session.clone())
            .collect();
        out.sort_by_key(|s| s.started_at);
        out
    }

    pub fn find_for_worktree_language(
        &self,
        worktree_id: WorktreeId,
        language_id: &str,
    ) -> Option<LspServerId> {
        self.inner
            .iter()
            .find(|e| {
                e.value().session.worktree_id == worktree_id
                    && e.value().session.language_id == language_id
            })
            .map(|e| *e.key())
    }

    /// Kill every server. Called from graceful shutdown.
    pub fn kill_all(&self) {
        let ids: Vec<_> = self.inner.iter().map(|e| *e.key()).collect();
        for id in ids {
            if let Some((_, h)) = self.inner.remove(&id) {
                drop(h.writer.lock().take());
                let _ = h.child.lock().kill();
            }
        }
    }
}
