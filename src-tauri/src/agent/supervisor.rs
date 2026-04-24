use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::util::errors::{AppError, AppResult};
use crate::util::ids::{AgentSessionId, WorktreeId};

use super::hooks::{self, HookActivityMap};
use super::{AgentActivity, AgentBackendKind, AgentEvent, AgentSession, AgentStatus};

/// Newlines are the universal "real output" signal across TUI agents — all of
/// Claude Code, Codex, Kiro stream new content on new lines, and spinners
/// never emit them (they rewrite a single line via `\r`). See
/// `activity_for_worktree` for how the windows compose.
const WORKING_WINDOW: Duration = Duration::from_secs(2);
const IDLE_WINDOW: Duration = Duration::from_secs(10);
/// Spinner or other byte activity seen within this window while newlines are
/// stalled keeps us in `Idle` rather than escalating to `NeedsAttention`.
const SPINNER_ACTIVITY_WINDOW: Duration = Duration::from_secs(3);

/// Keep the last ~4 MB of agent output per session. Plan doc says 8 MB, but
/// we pay JSON-number-array serialization cost on attach so smaller is kinder.
const RING_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Shared mutable state per agent. Reader thread writes to `ring` + `channel`;
/// `attach` swaps the channel and replays the ring.
struct AgentShared {
    ring: VecDeque<u8>,
    channel: Option<Channel<AgentEvent>>,
    status: AgentStatus,
    /// Last time the reader saw a `\n` byte — treated as "real output".
    last_newline: Instant,
    /// Last time the reader saw any byte at all (including spinner rewrites).
    last_any_output: Instant,
    /// Last time an **attention** pattern (e.g. `[y/N]`, Kiro's "requires
    /// approval" menu, `Press enter`) appeared. The non-hook classifier
    /// promotes to NeedsAttention when this is the most recent strong signal.
    /// `None` until the first hit.
    last_attention_match: Option<Instant>,
    /// Last time an **idle-beacon** pattern (Kiro's "ask a question or
    /// describe a task" REPL prompt) appeared. Forces Idle when this is the
    /// most recent strong signal — without it, Kiro's blinking-cursor idle
    /// state confuses byte timing into NeedsAttention.
    last_idle_match: Option<Instant>,
}

/// Byte patterns signalling an interactive prompt that requires a user
/// response — generic CLI confirmation gates plus Kiro's approval-menu header.
/// Short, stable strings. False positives are cheap (a transient NeedsAttention
/// dot that expires with `PATTERN_TTL`); false negatives fall back to byte
/// timing.
const ATTENTION_PATTERNS: &[&[u8]] = &[
    b"[y/N]",
    b"[Y/n]",
    b"(y/n)",
    b"(Y/n)",
    b"(y/N)",
    b"Press enter",
    b"Press Enter",
    b"Press ENTER",
    b"press any key",
    // Kiro permission-approval menu header ("shell requires approval",
    // "file write requires approval", …). Distinctive phrase; not expected
    // in ordinary tool output.
    b"requires approval",
];

/// Byte patterns signalling the agent is idle and waiting for a new prompt.
/// Without this, Kiro's cursor-blinking REPL rewrites trick byte timing into
/// classifying idle as NeedsAttention.
const IDLE_PATTERNS: &[&[u8]] = &[
    // Kiro REPL prompt shown when the agent finishes a turn and is waiting
    // for the next user input.
    b"ask a question or describe a task",
];

/// How long a pattern match remains authoritative. Kiro redraws its menus
/// and idle beacon on cursor blink / arrow nav, so this typically refreshes
/// well within the window; the TTL is just a safety valve for stuck state.
const PATTERN_TTL: Duration = Duration::from_secs(45);

fn scan_patterns(chunk: &[u8], patterns: &[&[u8]]) -> bool {
    patterns
        .iter()
        .any(|needle| memmem_slice(chunk, needle))
}

/// Tiny substring search — no dep needed for the handful of short needles we
/// scan per chunk. Cost is O(chunk * needle) per pattern, fine at 8 KiB reads.
fn memmem_slice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return needle.is_empty();
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Handle kept by the manager; holding it keeps the PTY + child alive.
pub struct AgentHandle {
    pub session: AgentSession,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    shared: Arc<Mutex<AgentShared>>,
}

pub struct AgentRegistry {
    inner: DashMap<AgentSessionId, AgentHandle>,
    /// Hook-driven activity per worktree — populated by the file watcher
    /// on writes to `<app_config>/hook-state/<worktree_id>.state`.
    hook_activity: HookActivityMap,
    /// Keeps the hook file watcher alive for the lifetime of the registry.
    #[allow(dead_code)]
    hook_watcher: Mutex<Option<Box<dyn std::any::Any + Send + Sync>>>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self {
            inner: DashMap::new(),
            hook_activity: std::sync::Arc::new(DashMap::new()),
            hook_watcher: Mutex::new(None),
        }
    }

    /// Start the hook-state watcher. Safe to call more than once; subsequent
    /// calls are no-ops. Called once at app startup from `setup()`.
    pub fn start_hook_watcher(&self, app: &AppHandle) -> AppResult<()> {
        let mut guard = self.hook_watcher.lock();
        if guard.is_some() {
            return Ok(());
        }
        let w = hooks::start_watcher(app, self.hook_activity.clone())?;
        *guard = Some(w);
        Ok(())
    }

    pub fn hook_activity(&self) -> &HookActivityMap {
        &self.hook_activity
    }

    pub fn list_for_worktree(&self, worktree_id: WorktreeId) -> Vec<AgentSession> {
        let mut sessions: Vec<AgentSession> = self
            .inner
            .iter()
            .filter(|e| e.value().session.worktree_id == worktree_id)
            .map(|e| e.value().session.clone())
            .collect();
        sessions.sort_by_key(|s| s.started_at);
        sessions
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

    /// Activity classification for a worktree, aggregated across **all** of
    /// its agents. Returns the most-alerting state: NeedsAttention > Working
    /// > Idle > Inactive. No running agents → Inactive.
    ///
    /// Preferred signal is Claude's hook events (see `agent::hooks`), which
    /// are authoritative. Fallback for other backends (Kiro, Codex) is a
    /// hybrid heuristic: byte timing for Working/Idle, plus a pattern scan
    /// for common confirmation prompts (`[y/N]`, "Press enter") that
    /// promotes Idle to NeedsAttention when a response is clearly pending.
    pub fn activity_for_worktree(&self, worktree_id: WorktreeId) -> AgentActivity {
        let any_running = self.inner.iter().any(|e| {
            e.value().session.worktree_id == worktree_id
                && matches!(
                    e.value().shared.lock().status,
                    AgentStatus::Running | AgentStatus::Starting
                )
        });
        if !any_running {
            return AgentActivity::Inactive;
        }

        if let Some(entry) = self.hook_activity.get(&worktree_id) {
            let (act, set_at) = *entry.value();
            // Claude occasionally doesn't fire `Stop` after the user
            // rejects a permission prompt — the `needs-attention` signal
            // then never gets overwritten. Expire it to `idle` after a
            // grace period so the dot recovers. Other states don't need
            // this: `working` gets replaced by the next tool boundary,
            // and `idle` is already the recovered state.
            const NEEDS_ATTENTION_TTL: Duration = Duration::from_secs(45);
            if matches!(act, AgentActivity::NeedsAttention)
                && set_at.elapsed() > NEEDS_ATTENTION_TTL
            {
                return AgentActivity::Idle;
            }
            return act;
        }

        let mut best = AgentActivity::Inactive;
        for e in self.inner.iter() {
            if e.value().session.worktree_id != worktree_id {
                continue;
            }
            let sh = e.value().shared.lock();
            if !matches!(sh.status, AgentStatus::Running | AgentStatus::Starting) {
                continue;
            }
            // Pattern signals (when fresh) are more reliable than byte timing
            // for non-Claude backends: Kiro's idle beacon and approval menus
            // are explicit states we can read directly. Whichever pattern
            // fired most recently wins; only fall back to byte timing when
            // neither is fresh.
            let att = sh.last_attention_match.filter(|t| t.elapsed() < PATTERN_TTL);
            let idl = sh.last_idle_match.filter(|t| t.elapsed() < PATTERN_TTL);
            let pattern_state = match (att, idl) {
                (Some(a_t), Some(i_t)) if a_t >= i_t => Some(AgentActivity::NeedsAttention),
                (Some(_), Some(_)) => Some(AgentActivity::Idle),
                (Some(_), None) => Some(AgentActivity::NeedsAttention),
                (None, Some(_)) => Some(AgentActivity::Idle),
                (None, None) => None,
            };
            let a = match pattern_state {
                Some(s) => s,
                None => {
                    let since_newline = sh.last_newline.elapsed();
                    let since_any = sh.last_any_output.elapsed();
                    if since_newline < WORKING_WINDOW {
                        AgentActivity::Working
                    } else if since_newline < IDLE_WINDOW && since_any < SPINNER_ACTIVITY_WINDOW {
                        AgentActivity::Idle
                    } else {
                        AgentActivity::NeedsAttention
                    }
                }
            };
            best = max_severity(best, a);
        }
        best
    }

    /// Kill every agent. Called from graceful shutdown.
    pub fn kill_all(&self) {
        let ids: Vec<_> = self.inner.iter().map(|e| *e.key()).collect();
        for id in ids {
            if let Some((_, h)) = self.inner.remove(&id) {
                let _ = h.child.lock().kill();
            }
        }
    }
}

fn max_severity(a: AgentActivity, b: AgentActivity) -> AgentActivity {
    fn rank(a: AgentActivity) -> u8 {
        match a {
            AgentActivity::NeedsAttention => 3,
            AgentActivity::Working => 2,
            AgentActivity::Idle => 1,
            AgentActivity::Inactive => 0,
        }
    }
    if rank(a) >= rank(b) {
        a
    } else {
        b
    }
}

/// Launch an agent in `cwd` and stream its PTY output over `channel`.
/// At most one agent per worktree — launching a second returns `AlreadyOpen`.
pub fn launch(
    app: &AppHandle,
    registry: &AgentRegistry,
    worktree_id: WorktreeId,
    cwd: PathBuf,
    is_main_clone: bool,
    backend: AgentBackendKind,
    argv_override: Option<Vec<String>>,
    cols: u16,
    rows: u16,
    channel: Channel<AgentEvent>,
) -> AppResult<AgentSession> {
    if is_main_clone {
        return Err(AppError::Unknown(
            "agents run in worktrees, not the main clone".into(),
        ));
    }

    // Install Claude Code hooks in the worktree *before* spawning the
    // child, so the config is on disk when Claude reads settings.
    if matches!(backend, AgentBackendKind::ClaudeCode) {
        if let Err(e) = hooks::install(app, &cwd, worktree_id) {
            tracing::warn!(?e, %worktree_id, "failed to install Claude hooks");
        }
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

    let shared = Arc::new(Mutex::new(AgentShared {
        ring: VecDeque::with_capacity(RING_MAX_BYTES / 16),
        channel: Some(channel.clone()),
        status: AgentStatus::Running,
        last_newline: Instant::now(),
        last_any_output: Instant::now(),
        last_attention_match: None,
        last_idle_match: None,
    }));

    // Announce "Running" immediately so the UI can swap state.
    let _ = channel.send(AgentEvent::Status {
        status: AgentStatus::Running,
    });

    // Reader thread: pump PTY output into the ring buffer + currently-attached
    // channel. Exit event fires on EOF and updates the shared status so future
    // attaches see it.
    let shared_for_reader = shared.clone();
    std::thread::Builder::new()
        .name(format!("agent-reader-{session_id}"))
        .spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        let saw_newline = chunk.contains(&b'\n');
                        let saw_attention = scan_patterns(chunk, ATTENTION_PATTERNS);
                        let saw_idle = scan_patterns(chunk, IDLE_PATTERNS);
                        let mut sh = shared_for_reader.lock();
                        sh.ring.extend(chunk.iter().copied());
                        let excess = sh.ring.len().saturating_sub(RING_MAX_BYTES);
                        if excess > 0 {
                            sh.ring.drain(..excess);
                        }
                        let now = Instant::now();
                        sh.last_any_output = now;
                        if saw_newline {
                            sh.last_newline = now;
                        }
                        if saw_attention {
                            sh.last_attention_match = Some(now);
                        }
                        if saw_idle {
                            sh.last_idle_match = Some(now);
                        }
                        if let Some(ch) = sh.channel.as_ref() {
                            // If the current attached channel breaks, detach it;
                            // ring buffer still fills so a reattach recovers.
                            if ch
                                .send(AgentEvent::Data {
                                    bytes: buf[..n].to_vec(),
                                })
                                .is_err()
                            {
                                sh.channel = None;
                            }
                        }
                    }
                    Err(e) => {
                        tracing::debug!(?e, %session_id, "agent pty read ended");
                        break;
                    }
                }
            }
            let exit = AgentStatus::Exited { code: None };
            let mut sh = shared_for_reader.lock();
            sh.status = exit.clone();
            if let Some(ch) = sh.channel.as_ref() {
                let _ = ch.send(AgentEvent::Status { status: exit });
            }
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
            shared,
        },
    );
    tracing::info!(%session_id, %worktree_id, ?argv, "launched agent");

    Ok(session)
}

/// Attach a fresh Channel to an existing session. Replays the ring buffer
/// into the new channel in one chunk, then wires subsequent reader output to
/// it. Returns the session snapshot (status may be `Exited` if the child
/// already died — caller decides whether to still show the replay).
pub fn attach(
    registry: &AgentRegistry,
    id: AgentSessionId,
    channel: Channel<AgentEvent>,
) -> AppResult<AgentSession> {
    let handle = registry
        .inner
        .get(&id)
        .ok_or_else(|| AppError::Unknown(format!("unknown agent: {id}")))?;
    let session = handle.session.clone();
    let mut sh = handle.shared.lock();

    if !sh.ring.is_empty() {
        let replay: Vec<u8> = sh.ring.iter().copied().collect();
        let _ = channel.send(AgentEvent::Data { bytes: replay });
    }
    let _ = channel.send(AgentEvent::Status {
        status: sh.status.clone(),
    });
    sh.channel = Some(channel);
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
        let _ = handle.child.lock().kill();
        tracing::info!(%id, "killed agent");
    }
}

pub fn kill_for_worktree(registry: &AgentRegistry, worktree_id: WorktreeId) {
    let ids: Vec<_> = registry
        .inner
        .iter()
        .filter(|e| e.value().session.worktree_id == worktree_id)
        .map(|e| *e.key())
        .collect();
    for id in ids {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn has_attention(chunk: &[u8]) -> bool {
        scan_patterns(chunk, ATTENTION_PATTERNS)
    }
    fn has_idle(chunk: &[u8]) -> bool {
        scan_patterns(chunk, IDLE_PATTERNS)
    }

    #[test]
    fn attention_patterns_match_known_confirmations() {
        assert!(has_attention(b"Proceed? [y/N] "));
        assert!(has_attention(b"Overwrite? [Y/n] "));
        assert!(has_attention(b"continue? (y/n) "));
        assert!(has_attention(b"Press enter to continue"));
        assert!(has_attention(b"Press ENTER"));
        assert!(has_attention(b"... press any key to dismiss"));
    }

    #[test]
    fn attention_patterns_match_kiro_approval_menu() {
        // Real Kiro output shape for its permission gates.
        let sample = b"\x1b[2J  shell requires approval\r\n  \xe2\x9d\xaf Yes, single permission\r\n    Trust, always allow in this session\r\n    No (Tab to edit)\r\n";
        assert!(has_attention(sample));
        // File-write variant should trigger the same header.
        assert!(has_attention(b"file write requires approval"));
    }

    #[test]
    fn idle_patterns_match_kiro_repl_prompt() {
        assert!(has_idle(b"ask a question or describe a task"));
        // Leading ANSI escape (clear-line) shouldn't break the scan — the
        // plain-text portion of the chunk still contains the phrase.
        assert!(has_idle(b"\x1b[2K\rask a question or describe a task"));
    }

    #[test]
    fn attention_and_idle_pools_do_not_overlap() {
        // Make sure the two pattern lists don't share strings — a chunk
        // triggering both would have ambiguous meaning.
        for a in ATTENTION_PATTERNS {
            for i in IDLE_PATTERNS {
                assert_ne!(a, i, "pattern appears in both pools: {:?}", a);
            }
        }
    }

    #[test]
    fn scan_patterns_ignores_unrelated_output() {
        assert!(!has_attention(b""));
        assert!(!has_attention(b"Running tests...\n"));
        assert!(!has_attention(b"y or n?")); // not our canonical pattern
        assert!(!has_attention(b"[info] building"));
        assert!(!has_idle(b"Ask a Question"));
    }

    #[test]
    fn scan_patterns_finds_pattern_anywhere_in_chunk() {
        let mut big = vec![b' '; 2000];
        big.extend_from_slice(b"[y/N]");
        big.extend(std::iter::repeat(b' ').take(1000));
        assert!(has_attention(&big));
    }
}
