use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use tauri::ipc::Channel;

use crate::util::errors::{AppError, AppResult};
use crate::util::ids::{LspServerId, WorktreeId};

use super::registry::{LspHandle, LspRegistry, LspShared};
use super::{LspConfig, LspEvent, LspServerSession, LspServerStatus};

/// Spawn a fresh server or, if one already exists for `(worktree_id,
/// language_id)`, reattach `channel` to it. Matches the lazy-spawn model:
/// the frontend calls this on first file open of the language.
pub fn ensure(
    registry: &LspRegistry,
    worktree_id: WorktreeId,
    config: &LspConfig,
    root_path: PathBuf,
    channel: Channel<LspEvent>,
) -> AppResult<LspServerSession> {
    if let Some(id) = registry.find_for_worktree_language(worktree_id, &config.id) {
        return attach(registry, id, channel);
    }
    spawn(registry, worktree_id, config, root_path, channel)
}

fn spawn(
    registry: &LspRegistry,
    worktree_id: WorktreeId,
    config: &LspConfig,
    root_path: PathBuf,
    channel: Channel<LspEvent>,
) -> AppResult<LspServerSession> {
    let mut cmd = Command::new(&config.command);
    cmd.args(&config.args);
    cmd.current_dir(&root_path);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    for (k, v) in &config.env {
        cmd.env(k, v);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Command missing — send a NotFound status so the frontend can
            // toast the install hint without a second command roundtrip.
            let status = LspServerStatus::NotFound {
                command: config.command.clone(),
                hint: config.install_hint.clone(),
            };
            let _ = channel.send(LspEvent::Status {
                status: status.clone(),
            });
            return Err(AppError::Unknown(format!(
                "LSP command not found: {}",
                config.command
            )));
        }
        Err(e) => {
            return Err(AppError::Unknown(format!("spawn {}: {e}", config.command)));
        }
    };

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Unknown(format!("no stdin for {}", config.command)))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Unknown(format!("no stdout for {}", config.command)))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Unknown(format!("no stderr for {}", config.command)))?;

    let server_id = LspServerId::new();
    let argv = std::iter::once(config.command.clone())
        .chain(config.args.iter().cloned())
        .collect::<Vec<_>>();
    let root_uri = format!("file://{}", root_path.display());

    let session = LspServerSession {
        id: server_id,
        worktree_id,
        language_id: config.id.clone(),
        root_uri,
        argv,
        started_at: now_millis(),
        status: LspServerStatus::Running,
    };

    let shared = Arc::new(Mutex::new(LspShared {
        channel: Some(channel.clone()),
        status: LspServerStatus::Running,
    }));

    let _ = channel.send(LspEvent::Status {
        status: LspServerStatus::Running,
    });

    // Stdout pump — forwards raw bytes to whichever channel is currently
    // attached. A detached channel just drops the bytes; the server keeps
    // running so reattach can rewire later. `monaco-languageclient` on the
    // renderer reassembles Content-Length frames across chunks.
    let shared_stdout = shared.clone();
    let mut stdout_reader = stdout;
    std::thread::Builder::new()
        .name(format!("lsp-stdout-{server_id}"))
        .spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match stdout_reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let sh = shared_stdout.lock();
                        if let Some(ch) = sh.channel.as_ref() {
                            let _ = ch.send(LspEvent::Data {
                                bytes: buf[..n].to_vec(),
                            });
                        }
                    }
                    Err(e) => {
                        tracing::debug!(?e, %server_id, "lsp stdout read ended");
                        break;
                    }
                }
            }
            let exit = LspServerStatus::Exited { code: None };
            let mut sh = shared_stdout.lock();
            sh.status = exit.clone();
            if let Some(ch) = sh.channel.as_ref() {
                let _ = ch.send(LspEvent::Status { status: exit });
            }
            tracing::info!(%server_id, "lsp stream closed");
        })
        .map_err(|e| AppError::Unknown(format!("spawn lsp stdout reader: {e}")))?;

    // Stderr pump — forwarded as UTF-8 log lines for the renderer dev tools
    // and mirrored into our tracing output for the tauri-dev console.
    let shared_stderr = shared.clone();
    let mut stderr_reader = stderr;
    std::thread::Builder::new()
        .name(format!("lsp-stderr-{server_id}"))
        .spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match stderr_reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        tracing::debug!(%server_id, "{}", text.trim_end());
                        let sh = shared_stderr.lock();
                        if let Some(ch) = sh.channel.as_ref() {
                            let _ = ch.send(LspEvent::Stderr { text });
                        }
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| AppError::Unknown(format!("spawn lsp stderr reader: {e}")))?;

    registry.inner.insert(
        server_id,
        LspHandle {
            session: session.clone(),
            writer: Arc::new(Mutex::new(Some(stdin))),
            child: Arc::new(Mutex::new(child)),
            shared,
        },
    );
    tracing::info!(%server_id, %worktree_id, language = %config.id, "spawned lsp");
    Ok(session)
}

/// Attach a fresh channel to an existing session. Mirrors `agent::attach`
/// but without a ring-buffer replay — LSP is inherently request/response,
/// so losing mid-stream bytes means the renderer just reissues whatever
/// it needs. A server-wide replay would be more harmful than helpful (the
/// client would process stale responses as new ones).
pub fn attach(
    registry: &LspRegistry,
    id: LspServerId,
    channel: Channel<LspEvent>,
) -> AppResult<LspServerSession> {
    let handle = registry
        .inner
        .get(&id)
        .ok_or_else(|| AppError::Unknown(format!("unknown lsp: {id}")))?;
    let session = handle.session.clone();
    let mut sh = handle.shared.lock();
    let _ = channel.send(LspEvent::Status {
        status: sh.status.clone(),
    });
    sh.channel = Some(channel);
    Ok(session)
}

pub fn write_stdin(
    registry: &LspRegistry,
    id: LspServerId,
    data: &[u8],
) -> AppResult<()> {
    let handle = registry
        .inner
        .get(&id)
        .ok_or_else(|| AppError::Unknown(format!("unknown lsp: {id}")))?;
    let mut writer = handle.writer.lock();
    let stdin = writer
        .as_mut()
        .ok_or_else(|| AppError::Unknown(format!("lsp stdin closed: {id}")))?;
    stdin
        .write_all(data)
        .map_err(|e| AppError::Io(format!("lsp write: {e}")))?;
    stdin
        .flush()
        .map_err(|e| AppError::Io(format!("lsp flush: {e}")))?;
    Ok(())
}

pub fn kill(registry: &LspRegistry, id: LspServerId) {
    if let Some((_, handle)) = registry.inner.remove(&id) {
        // Drop stdin first so servers that honor it (most do) can shut
        // down cleanly. SIGKILL as a fallback — we don't wait.
        drop(handle.writer.lock().take());
        let _ = handle.child.lock().kill();
        tracing::info!(%id, "killed lsp");
    }
}

pub fn kill_for_worktree(registry: &LspRegistry, worktree_id: WorktreeId) {
    let ids: Vec<_> = registry
        .inner
        .iter()
        .filter(|e| e.value().session.worktree_id == worktree_id)
        .map(|e| *e.key())
        .collect();
    for id in ids {
        kill(registry, id);
    }
}

pub fn kill_for_language(registry: &LspRegistry, language_id: &str) {
    let ids: Vec<_> = registry
        .inner
        .iter()
        .filter(|e| e.value().session.language_id == language_id)
        .map(|e| *e.key())
        .collect();
    for id in ids {
        kill(registry, id);
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
