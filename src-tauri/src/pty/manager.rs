use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;

use crate::util::errors::{AppError, AppResult};
use crate::util::ids::{TerminalId, WorktreeId};

use super::{PtyEvent, TerminalSession};

/// Cap the per-terminal replay ring. Same reasoning as the agent ring —
/// terminals scroll faster than agents stream text but the replay semantics
/// are identical: on re-attach, we blast the buffered bytes into the fresh
/// Channel so xterm redraws its scrollback.
const RING_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Shared mutable state per terminal. Reader thread writes to `ring` +
/// `channel`; `attach` swaps the channel and replays the ring so navigation
/// away and back doesn't lose history.
struct TerminalShared {
    ring: VecDeque<u8>,
    channel: Option<Channel<PtyEvent>>,
    /// `true` once the child exits — attach still works (replays the ring
    /// + a fresh Exit event) so the user can scroll back through output of
    /// a dead terminal before deciding to close the tab.
    exited: Option<Option<i32>>,
}

/// Per-terminal handle owned by the manager. Keeping it alive keeps the PTY
/// alive. Dropping it (via [`close`]) tears everything down.
pub struct TerminalHandle {
    pub session: TerminalSession,
    /// Writer half of the PTY master — used by `pty_write` and resize.
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    shared: Arc<Mutex<TerminalShared>>,
}

#[derive(Default)]
pub struct TerminalRegistry {
    inner: DashMap<TerminalId, TerminalHandle>,
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Kill every terminal. Called from graceful shutdown.
    pub fn kill_all(&self) {
        let ids: Vec<_> = self.inner.iter().map(|e| *e.key()).collect();
        for id in ids {
            if let Some((_, h)) = self.inner.remove(&id) {
                let _ = h.child.lock().kill();
            }
        }
    }
}

pub fn open(
    registry: &TerminalRegistry,
    worktree_id: WorktreeId,
    cwd: PathBuf,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    channel: Channel<PtyEvent>,
) -> AppResult<TerminalSession> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Unknown(format!("openpty: {e}")))?;

    let shell_path = shell
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/zsh".to_string());

    let mut cmd = CommandBuilder::new(&shell_path);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    // Inherit COLORTERM etc from parent if present.
    if let Ok(ct) = std::env::var("COLORTERM") {
        cmd.env("COLORTERM", ct);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Unknown(format!("spawn shell: {e}")))?;

    // Reader half for the background thread; writer half kept in handle.
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::Unknown(format!("clone reader: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::Unknown(format!("take writer: {e}")))?;

    let terminal_id = TerminalId::new();

    let shared = Arc::new(Mutex::new(TerminalShared {
        ring: VecDeque::new(),
        channel: Some(channel),
        exited: None,
    }));

    // Reader thread: pump bytes into the ring + whichever channel is
    // currently attached. If the channel send fails (frontend tore it down
    // on unmount), detach without killing — a later `attach` call will
    // hand us a fresh Channel and replay the ring.
    let shared_for_reader = shared.clone();
    std::thread::Builder::new()
        .name(format!("pty-reader-{terminal_id}"))
        .spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        let mut sh = shared_for_reader.lock();
                        sh.ring.extend(chunk.iter().copied());
                        let excess = sh.ring.len().saturating_sub(RING_MAX_BYTES);
                        if excess > 0 {
                            sh.ring.drain(..excess);
                        }
                        if let Some(ch) = sh.channel.as_ref() {
                            if ch
                                .send(PtyEvent::Data {
                                    bytes: chunk.to_vec(),
                                })
                                .is_err()
                            {
                                sh.channel = None;
                            }
                        }
                    }
                    Err(e) => {
                        tracing::debug!(?e, %terminal_id, "pty read ended");
                        break;
                    }
                }
            }
            let mut sh = shared_for_reader.lock();
            sh.exited = Some(None);
            if let Some(ch) = sh.channel.as_ref() {
                let _ = ch.send(PtyEvent::Exit { code: None });
            }
        })
        .map_err(|e| AppError::Unknown(format!("spawn pty reader: {e}")))?;

    let session = TerminalSession {
        id: terminal_id,
        worktree_id,
        shell: shell_path,
        cols,
        rows,
        alive: true,
    };

    registry.inner.insert(
        terminal_id,
        TerminalHandle {
            session: session.clone(),
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            child: Arc::new(Mutex::new(child)),
            shared,
        },
    );
    tracing::info!(%terminal_id, %worktree_id, cwd = %cwd.display(), "opened terminal");

    Ok(session)
}

pub fn write(registry: &TerminalRegistry, id: TerminalId, data: &[u8]) -> AppResult<()> {
    let handle = registry
        .inner
        .get(&id)
        .ok_or_else(|| AppError::Unknown(format!("unknown terminal: {id}")))?;
    let mut writer = handle.writer.lock();
    writer
        .write_all(data)
        .map_err(|e| AppError::Io(format!("pty write: {e}")))?;
    writer
        .flush()
        .map_err(|e| AppError::Io(format!("pty flush: {e}")))?;
    Ok(())
}

pub fn resize(
    registry: &TerminalRegistry,
    id: TerminalId,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    let handle = registry
        .inner
        .get(&id)
        .ok_or_else(|| AppError::Unknown(format!("unknown terminal: {id}")))?;
    let master = handle.master.lock();
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Unknown(format!("pty resize: {e}")))?;
    Ok(())
}

pub fn close(registry: &TerminalRegistry, id: TerminalId) {
    if let Some((_, handle)) = registry.inner.remove(&id) {
        let _ = handle.child.lock().kill();
        tracing::info!(%id, "closed terminal");
    }
}

/// Attach a fresh Channel to an existing terminal. Replays the ring buffer
/// into the new channel so xterm redraws its scrollback on remount, then
/// wires subsequent reader output to it. If the child already exited, the
/// replay is followed by a synthetic `Exit` event so the frontend reflects
/// the dead state immediately.
pub fn attach(
    registry: &TerminalRegistry,
    id: TerminalId,
    channel: Channel<PtyEvent>,
) -> AppResult<TerminalSession> {
    let handle = registry
        .inner
        .get(&id)
        .ok_or_else(|| AppError::Unknown(format!("unknown terminal: {id}")))?;
    let session = handle.session.clone();
    let mut sh = handle.shared.lock();

    if !sh.ring.is_empty() {
        let replay: Vec<u8> = sh.ring.iter().copied().collect();
        let _ = channel.send(PtyEvent::Data { bytes: replay });
    }
    if let Some(code) = sh.exited {
        let _ = channel.send(PtyEvent::Exit { code });
    }
    sh.channel = Some(channel);
    Ok(session)
}

/// All live terminal sessions for a worktree, in insertion order. Used by
/// the frontend on worktree switch to discover and re-attach to terminals
/// opened earlier in the same app session.
pub fn list_for_worktree(
    registry: &TerminalRegistry,
    worktree_id: WorktreeId,
) -> Vec<TerminalSession> {
    registry
        .inner
        .iter()
        .filter(|e| e.value().session.worktree_id == worktree_id)
        .map(|e| e.value().session.clone())
        .collect()
}

pub fn close_for_worktree(registry: &TerminalRegistry, worktree_id: WorktreeId) {
    let ids: Vec<_> = registry
        .inner
        .iter()
        .filter(|e| e.value().session.worktree_id == worktree_id)
        .map(|e| *e.key())
        .collect();
    for id in ids {
        close(registry, id);
    }
}
