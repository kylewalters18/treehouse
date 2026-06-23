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

/// How long a pattern match remains authoritative. Kiro redraws its menus
/// and idle beacon on cursor blink / arrow nav, so this typically refreshes
/// well within the window; the TTL is just a safety valve for stuck state.
const PATTERN_TTL: Duration = Duration::from_secs(45);

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
    /// User-configurable byte patterns for status detection. PTY
    /// reader threads clone this Arc at spawn time and read live —
    /// a `set_patterns` call updates every running agent's view on
    /// the next chunk, no respawn needed.
    patterns: std::sync::Arc<parking_lot::RwLock<super::patterns::AgentPatterns>>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self {
            inner: DashMap::new(),
            hook_activity: std::sync::Arc::new(DashMap::new()),
            hook_watcher: Mutex::new(None),
            patterns: std::sync::Arc::new(parking_lot::RwLock::new(
                super::patterns::AgentPatterns::defaults(),
            )),
        }
    }

    /// Replace the active pattern set (typically with whatever
    /// `patterns::load` returned at startup or after a reload).
    pub fn set_patterns(&self, p: super::patterns::AgentPatterns) {
        *self.patterns.write() = p;
    }

    pub fn patterns_handle(
        &self,
    ) -> std::sync::Arc<parking_lot::RwLock<super::patterns::AgentPatterns>> {
        self.patterns.clone()
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

        let now = Instant::now();
        let mut best = AgentActivity::Inactive;
        for e in self.inner.iter() {
            if e.value().session.worktree_id != worktree_id {
                continue;
            }
            let sh = e.value().shared.lock();
            if !matches!(sh.status, AgentStatus::Running | AgentStatus::Starting) {
                continue;
            }
            best = max_severity(best, Self::classify(e.value().session.backend, &sh, now));
        }
        best
    }

    /// Classify one non-Claude agent's activity from its output-timing and
    /// pattern timestamps. Pure (takes `now` rather than calling `Instant::now`)
    /// so the state machine is unit-testable — see `mod tests`.
    fn classify(backend: AgentBackendKind, sh: &AgentShared, now: Instant) -> AgentActivity {
        let since_any = now.saturating_duration_since(sh.last_any_output);
        if matches!(backend, AgentBackendKind::Kiro) {
            // Kiro renders a full-screen TUI with no reliable idle substring, so
            // output *rhythm* is the primary signal: a working turn streams bytes
            // continuously (spinner rewrites via `\r`, plus content); an idle turn
            // goes quiet (static screen; cursor blink is terminal-side).
            //
            // Byte activity is checked FIRST — streaming = Working even if
            // `requires approval` matched moments ago — so we leave NeedsAttention
            // the instant the user approves and work resumes. When quiet, the
            // prompt counts as *current* only if it's the last thing emitted:
            // `last_attention_match` and `last_any_output` share an instant on a
            // matching chunk, so `attn >= any` means "nothing since the prompt"
            // (still blocked). Once a turn flows work output past the prompt and
            // finishes, `any > attn` → Idle, not stuck amber.
            let blocked_on_prompt = sh.last_attention_match.is_some_and(|t| t >= sh.last_any_output);
            if since_any < WORKING_WINDOW {
                AgentActivity::Working
            } else if blocked_on_prompt {
                AgentActivity::NeedsAttention
            } else {
                AgentActivity::Idle
            }
        } else {
            // Codex etc.: a fresh pattern wins (most recent of attention/idle),
            // else newline byte-timing.
            let fresh = |t: &Instant| now.saturating_duration_since(*t) < PATTERN_TTL;
            let att = sh.last_attention_match.filter(|t| fresh(t));
            let idl = sh.last_idle_match.filter(|t| fresh(t));
            let pattern_state = match (att, idl) {
                (Some(a_t), Some(i_t)) if a_t >= i_t => Some(AgentActivity::NeedsAttention),
                (Some(_), Some(_)) => Some(AgentActivity::Idle),
                (Some(_), None) => Some(AgentActivity::NeedsAttention),
                (None, Some(_)) => Some(AgentActivity::Idle),
                (None, None) => None,
            };
            match pattern_state {
                Some(s) => s,
                None => {
                    let since_newline = now.saturating_duration_since(sh.last_newline);
                    if since_newline < WORKING_WINDOW {
                        AgentActivity::Working
                    } else if since_newline < IDLE_WINDOW && since_any < SPINNER_ACTIVITY_WINDOW {
                        AgentActivity::Idle
                    } else {
                        AgentActivity::NeedsAttention
                    }
                }
            }
        }
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
    backend: AgentBackendKind,
    argv_override: Option<Vec<String>>,
    cols: u16,
    rows: u16,
    channel: Channel<AgentEvent>,
) -> AppResult<AgentSession> {
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
    let patterns_for_reader = registry.patterns.clone();
    std::thread::Builder::new()
        .name(format!("agent-reader-{session_id}"))
        .spawn(move || {
            let mut buf = [0u8; 8192];
            // Rolling de-escaped tail for cross-chunk pattern matching.
            let mut scan_tail = String::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        let saw_newline = chunk.contains(&b'\n');
                        // Read patterns under the lock for as
                        // little time as possible — scan the
                        // de-escaped chunk and drop the read guard
                        // before taking the shared-state mutex below.
                        let (saw_attention, saw_idle) = {
                            let p = patterns_for_reader.read();
                            scan_chunk(&p, backend, &mut scan_tail, chunk)
                        };
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

/// Run the backend's `agents list` command in `cwd` and return the parsed
/// agent names. Codex has no analog and returns an empty list. CLI errors
/// (binary missing, non-zero exit, unparseable output) bubble up as Ok with
/// an empty list — surfacing the empty dropdown rather than a hard error
/// keeps the launch flow usable when discovery fails.
pub fn list_backend_agents(
    backend: super::AgentBackendKind,
    cwd: &std::path::Path,
) -> Vec<super::BackendAgent> {
    let argv: Vec<&str> = match backend {
        super::AgentBackendKind::ClaudeCode => vec!["claude", "agents", "list"],
        super::AgentBackendKind::Kiro => vec!["kiro-cli", "agent", "list"],
        super::AgentBackendKind::Codex => return vec![],
    };
    let output = match std::process::Command::new(argv[0])
        .args(&argv[1..])
        .current_dir(cwd)
        .output()
    {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            tracing::warn!(
                backend = ?backend,
                code = ?o.status.code(),
                "agents-list command exited non-zero"
            );
            return vec![];
        }
        Err(e) => {
            tracing::warn!(backend = ?backend, ?e, "agents-list command failed to spawn");
            return vec![];
        }
    };
    // Claude writes its agent list to stdout; kiro-cli writes to stderr.
    // Concatenate so the parser works regardless and we don't depend on
    // the CLI never changing which stream it picks.
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    match backend {
        super::AgentBackendKind::ClaudeCode => parse_claude_agents(&text),
        super::AgentBackendKind::Kiro => parse_kiro_agents(&text),
        super::AgentBackendKind::Codex => vec![],
    }
}

/// Strip CSI sequences (`\x1b[...m`) so Kiro's color-coded output can be
/// parsed line-by-line. Doesn't try to handle every escape — just enough
/// for the SGR codes the CLIs actually emit.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        // CSI (`ESC [`): consume the `[`, then the parameter/intermediate
        // bytes, and stop on the final byte 0x40-0x7E. Note `[` itself is
        // 0x5B (inside that range), so it must be skipped explicitly —
        // otherwise the scan ends immediately and leaks the params (e.g.
        // `38;5;208m`) as text, which is what broke Kiro status matching.
        if chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            // Other escapes (`ESC c`, charset selects, …) — drop ESC plus
            // its single following byte. OSC strings aren't common in the
            // status output we scan, so we don't special-case them.
            chars.next();
        }
    }
    out
}

/// How many trailing characters of stripped output we carry between reads
/// so an attention/idle phrase split across two PTY chunks still matches.
/// Comfortably larger than the longest default pattern; small enough that a
/// stale prompt scrolls out of the window within one screen of new output.
const SCAN_WINDOW: usize = 256;

/// Strip ANSI escapes from `chunk`, append to the rolling `tail`, scan the
/// window for attention/idle patterns, then trim `tail` back to the last
/// `SCAN_WINDOW` chars for the next read.
///
/// Pattern matching MUST run on de-escaped text: agent TUIs (Kiro, Codex)
/// wrap prompt strings like "requires approval" in color/cursor sequences,
/// so matching raw PTY bytes never hits. (Claude Code is unaffected — its
/// status comes from hooks, not patterns.) The rolling window covers the
/// case where a single screen draw lands across two `read()` calls.
fn scan_chunk(
    patterns: &super::patterns::AgentPatterns,
    backend: AgentBackendKind,
    tail: &mut String,
    chunk: &[u8],
) -> (bool, bool) {
    use super::patterns::Which;
    tail.push_str(&strip_ansi(&String::from_utf8_lossy(chunk)));
    let saw_attention = patterns.matches(backend, tail.as_bytes(), Which::Attention);
    let saw_idle = patterns.matches(backend, tail.as_bytes(), Which::Idle);
    let count = tail.chars().count();
    if count > SCAN_WINDOW {
        *tail = tail.chars().skip(count - SCAN_WINDOW).collect();
    }
    (saw_attention, saw_idle)
}

/// Claude `agents list` output is like:
/// ```text
/// 4 active agents
///
/// Built-in agents:
///   Explore · haiku
///   general-purpose · inherit
///   Plan · inherit
/// ```
/// Each agent row is two-space indented and contains ` · `. There may be
/// additional sections (`User agents:`, `Project agents:`) with the same
/// row shape.
fn parse_claude_agents(text: &str) -> Vec<super::BackendAgent> {
    let mut out = Vec::new();
    for line in text.lines() {
        if !line.starts_with("  ") {
            continue;
        }
        let trimmed = line.trim();
        let Some((name, _)) = trimmed.split_once('·') else {
            continue;
        };
        let name = name.trim();
        if !name.is_empty() {
            out.push(super::BackendAgent {
                name: name.to_string(),
            });
        }
    }
    out
}

/// Kiro `agent list` output (after ANSI strip) is like:
/// ```text
/// Workspace: ~/.../.kiro/agents
/// Global:    ~/.kiro/agents
///
/// * kiro_default    (Built-in)    Default agent
///   cpp-refactor    Workspace     Placeholder agent for C++
///                                  (main.cpp, point.{h,cpp}).
///   kiro_help       (Built-in)    Help agent that answers questions ...
///                                  using documentation
/// ```
/// Built-in agents show `(Built-in)`; workspace/user agents show a plain
/// type word (no parens) — so we can't filter on parentheses. Instead use
/// indentation: agent rows start with `* ` or exactly two spaces;
/// description-continuation lines start with many more spaces.
fn parse_kiro_agents(text: &str) -> Vec<super::BackendAgent> {
    let stripped = strip_ansi(text);
    let mut out = Vec::new();
    for line in stripped.lines() {
        let is_agent_row = line.starts_with("* ")
            || (line.starts_with("  ") && !line.starts_with("   "));
        if !is_agent_row {
            continue;
        }
        let trimmed = line.trim_start_matches(['*', ' ']);
        let Some(name) = trimmed.split_whitespace().next() else {
            continue;
        };
        // Header lines like "  Workspace: ..." would otherwise pass the
        // indent test if they were two-space-indented.
        if name.ends_with(':') {
            continue;
        }
        out.push(super::BackendAgent {
            name: name.to_string(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::patterns::{AgentPatterns, Which};

    fn has_attention_kiro(chunk: &[u8]) -> bool {
        AgentPatterns::defaults().matches(AgentBackendKind::Kiro, chunk, Which::Attention)
    }
    fn has_idle_kiro(chunk: &[u8]) -> bool {
        AgentPatterns::defaults().matches(AgentBackendKind::Kiro, chunk, Which::Idle)
    }
    fn has_attention_codex(chunk: &[u8]) -> bool {
        AgentPatterns::defaults().matches(AgentBackendKind::Codex, chunk, Which::Attention)
    }
    fn has_attention_claude(chunk: &[u8]) -> bool {
        AgentPatterns::defaults().matches(AgentBackendKind::ClaudeCode, chunk, Which::Attention)
    }

    /// `(now, ago)` where `ago(secs)` is an Instant `secs` before `now`. Built by
    /// addition off a base so there's never an Instant underflow on a freshly
    /// booted (low-uptime) machine.
    fn clock() -> (Instant, impl Fn(u64) -> Instant) {
        let base = Instant::now();
        let now = base + Duration::from_secs(10_000);
        (now, move |secs: u64| base + Duration::from_secs(10_000 - secs))
    }

    fn shared(
        any: Instant,
        newline: Instant,
        attention: Option<Instant>,
        idle: Option<Instant>,
    ) -> AgentShared {
        AgentShared {
            ring: VecDeque::new(),
            channel: None,
            status: AgentStatus::Running,
            last_newline: newline,
            last_any_output: any,
            last_attention_match: attention,
            last_idle_match: idle,
        }
    }

    #[test]
    fn kiro_streaming_is_working() {
        let (now, ago) = clock();
        let s = shared(ago(0), ago(0), None, None); // bytes just now
        assert_eq!(AgentRegistry::classify(AgentBackendKind::Kiro, &s, now), AgentActivity::Working);
    }

    #[test]
    fn kiro_quiet_with_no_prompt_is_idle() {
        let (now, ago) = clock();
        let s = shared(ago(5), ago(5), None, None); // quiet 5s, never prompted
        assert_eq!(AgentRegistry::classify(AgentBackendKind::Kiro, &s, now), AgentActivity::Idle);
    }

    #[test]
    fn kiro_quiet_on_current_prompt_needs_attention() {
        // The approval prompt was the last thing emitted (attn == any), quiet since.
        let (now, ago) = clock();
        let s = shared(ago(5), ago(5), Some(ago(5)), None);
        assert_eq!(AgentRegistry::classify(AgentBackendKind::Kiro, &s, now), AgentActivity::NeedsAttention);
    }

    #[test]
    fn kiro_resumed_work_overrides_recent_prompt() {
        // User approved → spinner streaming now; prompt matched 3s ago. Must NOT
        // be stuck amber — byte activity wins.
        let (now, ago) = clock();
        let s = shared(ago(0), ago(0), Some(ago(3)), None);
        assert_eq!(AgentRegistry::classify(AgentBackendKind::Kiro, &s, now), AgentActivity::Working);
    }

    #[test]
    fn kiro_idle_after_a_turn_that_began_with_a_prompt() {
        // Regression: approval shown 30s ago, work output flowed past it (5s ago),
        // now quiet → Idle, NOT stuck NeedsAttention.
        let (now, ago) = clock();
        let s = shared(ago(5), ago(5), Some(ago(30)), None);
        assert_eq!(AgentRegistry::classify(AgentBackendKind::Kiro, &s, now), AgentActivity::Idle);
    }

    #[test]
    fn attention_patterns_match_known_confirmations_for_kiro() {
        // Generic TUI prompts ride along on Kiro's pattern list.
        assert!(has_attention_kiro(b"Proceed? [y/N] "));
        assert!(has_attention_kiro(b"Overwrite? [Y/n] "));
        assert!(has_attention_kiro(b"continue? (y/n) "));
        assert!(has_attention_kiro(b"Press enter to continue"));
        assert!(has_attention_kiro(b"Press ENTER"));
        assert!(has_attention_kiro(b"... press any key to dismiss"));
    }

    #[test]
    fn attention_patterns_match_known_confirmations_for_codex() {
        // Codex shares the generic prompts but not Kiro's
        // approval-menu phrase.
        assert!(has_attention_codex(b"Proceed? [y/N] "));
        assert!(!has_attention_codex(b"file write requires approval"));
    }

    #[test]
    fn attention_patterns_match_kiro_approval_menu() {
        // Real Kiro output shape for its permission gates.
        let sample = b"\x1b[2J  shell requires approval\r\n  \xe2\x9d\xaf Yes, single permission\r\n    Trust, always allow in this session\r\n    No (Tab to edit)\r\n";
        assert!(has_attention_kiro(sample));
        // File-write variant should trigger the same header.
        assert!(has_attention_kiro(b"file write requires approval"));
    }

    #[test]
    fn kiro_idle_is_not_pattern_matched() {
        // Kiro has no reliable idle substring; idle is detected by output going
        // quiet (see `classify`), not by text. The old REPL phrase must NOT be
        // in the idle list — a stale match there would pin Idle for the match's
        // lifetime even after work resumed.
        assert!(!has_idle_kiro(b"ask a question or describe a task"));
    }

    #[test]
    fn scan_chunk_matches_phrase_with_interleaved_escapes() {
        // The reason raw-byte matching failed for Kiro: TUIs color words
        // individually, so escape sequences land *between* the words of a
        // phrase. scan_chunk de-escapes first, so the phrase reassembles.
        let p = AgentPatterns::defaults();
        let mut tail = String::new();
        let chunk =
            b"\x1b[1m\x1b[38;5;208mrequires\x1b[0m \x1b[2mapproval\x1b[0m to run";
        let (att, _idle) = scan_chunk(&p, AgentBackendKind::Kiro, &mut tail, chunk);
        assert!(att, "attention phrase split by color codes should match");
        // Sanity: the same bytes do NOT match without de-escaping, which is
        // exactly the bug this fixes.
        assert!(!has_attention_kiro(chunk));
    }

    #[test]
    fn scan_chunk_matches_phrase_split_across_reads() {
        // A single screen draw can straddle two read() calls; the rolling
        // window stitches the halves back together. (Uses an attention phrase
        // since Kiro no longer has an idle pattern.)
        let p = AgentPatterns::defaults();
        let mut tail = String::new();
        let (a1, _i1) = scan_chunk(
            &p,
            AgentBackendKind::Kiro,
            &mut tail,
            b"\x1b[2K\rfile write requires ap",
        );
        assert!(!a1, "first half alone shouldn't match");
        let (a2, _i2) =
            scan_chunk(&p, AgentBackendKind::Kiro, &mut tail, b"proval to run\r\n");
        assert!(a2, "phrase completed on the second read should match");
    }

    #[test]
    fn scan_chunk_window_evicts_stale_text() {
        // Once a screen of new output has gone by, a long-gone prompt scrolls
        // out of the window and stops re-matching.
        let p = AgentPatterns::defaults();
        let mut tail = String::new();
        scan_chunk(&p, AgentBackendKind::Kiro, &mut tail, b"requires approval");
        // One full window of unrelated output trims the phrase out of `tail`.
        let filler = vec![b'x'; SCAN_WINDOW + 64];
        scan_chunk(&p, AgentBackendKind::Kiro, &mut tail, &filler);
        let (att, _idle) =
            scan_chunk(&p, AgentBackendKind::Kiro, &mut tail, b"more output\n");
        assert!(!att, "stale phrase should have scrolled out of the window");
    }

    #[test]
    fn claude_defaults_are_empty_so_hooks_can_drive_status() {
        // Claude Code's status comes from its hooks; pattern fallback
        // is intentionally off by default to avoid double-firing on
        // generic TUI output a hook would otherwise classify.
        assert!(!has_attention_claude(b"Proceed? [y/N] "));
        assert!(!has_attention_claude(b"file write requires approval"));
    }

    #[test]
    fn attention_and_idle_pools_do_not_overlap() {
        // Make sure no string appears in both pools for any backend —
        // a chunk triggering both would have ambiguous meaning.
        let p = AgentPatterns::defaults();
        for bp in [&p.kiro, &p.codex, &p.claude_code] {
            for a in &bp.attention {
                for i in &bp.idle {
                    assert_ne!(a, i, "pattern appears in both pools: {:?}", a);
                }
            }
        }
    }

    #[test]
    fn scan_patterns_ignores_unrelated_output() {
        assert!(!has_attention_kiro(b""));
        assert!(!has_attention_kiro(b"Running tests...\n"));
        assert!(!has_attention_kiro(b"y or n?")); // not our canonical pattern
        assert!(!has_attention_kiro(b"[info] building"));
        assert!(!has_idle_kiro(b"Ask a Question"));
    }

    #[test]
    fn scan_patterns_finds_pattern_anywhere_in_chunk() {
        let mut big = vec![b' '; 2000];
        big.extend_from_slice(b"[y/N]");
        big.extend(std::iter::repeat(b' ').take(1000));
        assert!(has_attention_kiro(&big));
    }

    #[test]
    fn parse_claude_agents_extracts_built_in_names() {
        let sample = "4 active agents\n\nBuilt-in agents:\n  Explore · haiku\n  general-purpose · inherit\n  Plan · inherit\n  statusline-setup · sonnet\n";
        let agents = parse_claude_agents(sample);
        let names: Vec<_> = agents.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["Explore", "general-purpose", "Plan", "statusline-setup"]
        );
    }

    #[test]
    fn parse_kiro_agents_strips_ansi_and_skips_continuation_lines() {
        // Real `kiro-cli agent list` payload shape: ANSI-colored labels,
        // asterisk-marked default, mix of (Built-in) and Workspace types
        // (the latter has no parens), and a description that wraps onto
        // a continuation line containing parentheses of its own — which
        // mustn't be picked up as a phantom agent row. Built explicitly
        // (no string-continuation) so source indentation doesn't get
        // eaten and the parser sees real column positions.
        let lines = [
            "\x1b[38;5;244mWorkspace: \x1b[0m~/Code/foo/.kiro/agents",
            "\x1b[38;5;244mGlobal:    \x1b[0m~/.kiro/agents",
            "",
            "* kiro_default    \x1b[38;5;244m(Built-in)\x1b[0m    Default agent",
            "  cpp-refactor    Workspace     Placeholder Kiro agent for C++ refactoring tasks",
            "                                 (main.cpp, point.{h,cpp}).",
            "  kiro_help       \x1b[38;5;244m(Built-in)\x1b[0m    Help agent that answers questions about Kiro CLI",
            "                                 features using documentation",
            "  test-runner     Workspace     Placeholder Kiro agent that runs the test suite",
        ];
        let sample = lines.join("\n");
        let agents = parse_kiro_agents(&sample);
        let names: Vec<_> = agents.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["kiro_default", "cpp-refactor", "kiro_help", "test-runner"]
        );
    }
}
