use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;

use crate::util::errors::{AppError, AppResult};
use crate::util::ids::{AgentSessionId, WorktreeId};

use super::{AgentBackendKind, AgentEvent, AgentSession, AgentStatus};

/// Handle kept by the manager; holding it keeps the PTY + child alive.
pub struct AgentHandle {
    pub session: AgentSession,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

#[derive(Default)]
pub struct AgentRegistry {
    inner: DashMap<AgentSessionId, AgentHandle>,
    /// Index of the *single* active agent per worktree, for quick lookup.
    by_worktree: DashMap<WorktreeId, AgentSessionId>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_for_worktree(&self, worktree_id: WorktreeId) -> Option<AgentSession> {
        let id = *self.by_worktree.get(&worktree_id)?.value();
        self.inner.get(&id).map(|h| h.session.clone())
    }

    pub fn status_snapshot(&self, id: AgentSessionId) -> Option<AgentStatus> {
        self.inner.get(&id).map(|h| h.session.status.clone())
    }

    pub fn list_for_workspace<F: Fn(WorktreeId) -> bool>(
        &self,
        worktree_belongs: F,
    ) -> Vec<AgentSession> {
        self.inner
            .iter()
            .filter(|e| worktree_belongs(e.value().session.worktree_id))
            .map(|e| e.value().session.clone())
            .collect()
    }

    /// Kill every agent. Called from graceful shutdown.
    pub fn kill_all(&self) {
        let ids: Vec<_> = self.inner.iter().map(|e| *e.key()).collect();
        for id in ids {
            if let Some((_, h)) = self.inner.remove(&id) {
                let _ = h.child.lock().kill();
            }
        }
        self.by_worktree.clear();
    }
}

/// Launch an agent in `cwd` and stream its PTY output over `channel`.
/// At most one agent per worktree — launching a second returns `AlreadyOpen`.
pub fn launch(
    registry: &AgentRegistry,
    worktree_id: WorktreeId,
    cwd: PathBuf,
    backend: AgentBackendKind,
    argv_override: Option<Vec<String>>,
    cols: u16,
    rows: u16,
    channel: Channel<AgentEvent>,
) -> AppResult<AgentSession> {
    if registry.by_worktree.contains_key(&worktree_id) {
        return Err(AppError::AlreadyOpen(format!(
            "agent already running for worktree {worktree_id}"
        )));
    }

    let argv = argv_override
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| backend.default_argv());
    if argv.is_empty() {
        return Err(AppError::Unknown(
            "empty argv — generic CLI requires explicit argv".into(),
        ));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Unknown(format!("agent openpty: {e}")))?;

    let mut cmd = CommandBuilder::new(&argv[0]);
    for arg in argv.iter().skip(1) {
        cmd.arg(arg);
    }
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    if let Ok(ct) = std::env::var("COLORTERM") {
        cmd.env("COLORTERM", ct);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Unknown(format!("spawn agent: {e}")))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::Unknown(format!("clone reader: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::Unknown(format!("take writer: {e}")))?;

    let session_id = AgentSessionId::new();
    let session = AgentSession {
        id: session_id,
        worktree_id,
        backend,
        argv: argv.clone(),
        started_at: now_millis(),
        cols,
        rows,
        status: AgentStatus::Running,
    };

    // Announce "Running" immediately so the UI can swap state.
    let _ = channel.send(AgentEvent::Status {
        status: AgentStatus::Running,
    });

    // Reader thread: pump PTY output into the Channel. Exit event fires on EOF.
    let channel_for_reader = channel.clone();
    std::thread::Builder::new()
        .name(format!("agent-reader-{session_id}"))
        .spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if channel_for_reader
                            .send(AgentEvent::Data {
                                bytes: buf[..n].to_vec(),
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::debug!(?e, %session_id, "agent pty read ended");
                        break;
                    }
                }
            }
            let _ = channel_for_reader.send(AgentEvent::Status {
                status: AgentStatus::Exited { code: None },
            });
            tracing::info!(%session_id, "agent stream closed");
        })
        .map_err(|e| AppError::Unknown(format!("spawn agent reader: {e}")))?;

    registry.inner.insert(
        session_id,
        AgentHandle {
            session: session.clone(),
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            child: Arc::new(Mutex::new(child)),
        },
    );
    registry.by_worktree.insert(worktree_id, session_id);
    tracing::info!(%session_id, %worktree_id, ?argv, "launched agent");

    Ok(session)
}

pub fn write_stdin(
    registry: &AgentRegistry,
    id: AgentSessionId,
    data: &[u8],
) -> AppResult<()> {
    let handle = registry
        .inner
        .get(&id)
        .ok_or_else(|| AppError::Unknown(format!("unknown agent: {id}")))?;
    let mut w = handle.writer.lock();
    w.write_all(data)
        .map_err(|e| AppError::Io(format!("agent write: {e}")))?;
    w.flush()
        .map_err(|e| AppError::Io(format!("agent flush: {e}")))?;
    Ok(())
}

pub fn resize(
    registry: &AgentRegistry,
    id: AgentSessionId,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    let handle = registry
        .inner
        .get(&id)
        .ok_or_else(|| AppError::Unknown(format!("unknown agent: {id}")))?;
    handle
        .master
        .lock()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Unknown(format!("agent resize: {e}")))?;
    Ok(())
}

pub fn kill(registry: &AgentRegistry, id: AgentSessionId) {
    if let Some((_, handle)) = registry.inner.remove(&id) {
        registry
            .by_worktree
            .remove_if(&handle.session.worktree_id, |_, v| *v == id);
        let _ = handle.child.lock().kill();
        tracing::info!(%id, "killed agent");
    }
}

pub fn kill_for_worktree(registry: &AgentRegistry, worktree_id: WorktreeId) {
    if let Some((_, id)) = registry.by_worktree.remove(&worktree_id) {
        if let Some((_, handle)) = registry.inner.remove(&id) {
            let _ = handle.child.lock().kill();
            tracing::info!(%id, %worktree_id, "killed agent for removed worktree");
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
