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

use super::acp;
use super::history::{self, AgentHistory, AgentHistoryEntry};
use super::hooks::{self, HookSession, HookSessionMap};
use super::kiro_history;
use super::{
    AgentActivity, AgentBackendKind, AgentEvent, AgentOverview, AgentSession, AgentStatus,
    AgentTransport, PendingPrompt,
};

/// Keep the last ~4 MB of agent output per session. Plan doc says 8 MB, but
/// we pay JSON-number-array serialization cost on attach so smaller is kinder.
const RING_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Shared mutable state per agent. Reader thread writes to `ring` + `channel`;
/// `attach` swaps the channel and replays the ring.
struct AgentShared {
    ring: VecDeque<u8>,
    channel: Option<Channel<AgentEvent>>,
    status: AgentStatus,
    /// Last time the reader saw any output — the board's "changed" time for
    /// agents without status hooks.
    last_any_output: Instant,
    /// Last time the user (or the board) wrote to the agent's stdin. A
    /// hook-reported prompt that has been typed into since it appeared may
    /// already be answered — see `hook_state`.
    last_input: Option<Instant>,
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
    /// Hook-driven state per Claude session — populated by the file watcher
    /// on writes to `<app_config>/hook-state/session-<id>.<Event>.json`.
    hook_sessions: HookSessionMap,
    /// Keeps the hook file watcher alive for the lifetime of the registry.
    #[allow(dead_code)]
    hook_watcher: Mutex<Option<Box<dyn std::any::Any + Send + Sync>>>,
    /// Where each Claude session runs and which conversation it resumed,
    /// so hook events can be filed into `history` by worktree path.
    history_meta: Arc<DashMap<AgentSessionId, HistoryMeta>>,
    history: Arc<AgentHistory>,
    /// The same for Kiro sessions, so history can tell which conversation
    /// a running Kiro agent has open (see `history_for`).
    kiro_meta: DashMap<AgentSessionId, KiroMeta>,
    /// ACP-transport sessions (`agent::acp`). Every query below covers
    /// both maps, so callers needn't know which transport a session uses.
    pub(crate) acp: DashMap<AgentSessionId, acp::AcpHandle>,
}

struct HistoryMeta {
    cwd: PathBuf,
    resumed_from: Option<String>,
}

struct KiroMeta {
    cwd: PathBuf,
    started_at: u64,
    resumed_from: Option<String>,
}

/// Kiro writes a session's `created_at` a moment after spawn, but allow a
/// little skew either way.
const KIRO_START_SLACK_MS: u64 = 5_000;

impl AgentRegistry {
    pub fn new() -> Self {
        Self {
            inner: DashMap::new(),
            hook_sessions: std::sync::Arc::new(DashMap::new()),
            hook_watcher: Mutex::new(None),
            history_meta: Arc::new(DashMap::new()),
            history: Arc::new(AgentHistory::default()),
            kiro_meta: DashMap::new(),
            acp: DashMap::new(),
        }
    }

    pub(crate) fn history_handle(&self) -> Arc<AgentHistory> {
        self.history.clone()
    }

    /// The live agent (either transport) that has Claude conversation
    /// `claude_session_id` open.
    fn live_claude_agent(&self, claude_session_id: &str) -> Option<AgentSessionId> {
        self.hook_sessions
            .iter()
            .find(|h| h.value().claude_session_id.as_deref() == Some(claude_session_id))
            .map(|h| *h.key())
            .filter(|id| is_live(self, *id))
            .or_else(|| {
                self.acp
                    .iter()
                    .find(|a| {
                        a.value().is_live()
                            && a.value().agent_session_id().as_deref() == Some(claude_session_id)
                    })
                    .map(|a| *a.key())
            })
    }

    /// Start the hook-state watcher. Safe to call more than once; subsequent
    /// calls are no-ops. Called once at app startup from `setup()`.
    pub fn start_hook_watcher(&self, app: &AppHandle) -> AppResult<()> {
        let mut guard = self.hook_watcher.lock();
        if guard.is_some() {
            return Ok(());
        }
        let dir = crate::storage::config_dir(app)?;
        self.history.load(dir.join(history::HISTORY_FILE));
        let meta = self.history_meta.clone();
        let hist = self.history.clone();
        let w = hooks::start_watcher(app, self.hook_sessions.clone(), move |id, event, hook| {
            super::notify::activity_changed();
            // A turn starting (first one names the record) or ending (the
            // reply to show) is all the history needs.
            if !matches!(event, "UserPromptSubmit" | "Stop") {
                return;
            }
            let (Some(cid), Some(m)) = (hook.claude_session_id.as_deref(), meta.get(&id)) else {
                return;
            };
            hist.observe(
                &m.cwd,
                m.resumed_from.as_deref(),
                cid,
                hook.first_prompt.as_deref(),
                &history::LastTurn {
                    ai_title: hook.ai_title.clone(),
                    prompt: hook.task.clone(),
                    message: hook.last_message.clone(),
                },
                now_millis(),
            );
        })?;
        *guard = Some(w);
        Ok(())
    }

    /// Resumable Claude and Kiro conversations in `cwd`, newest first, each
    /// marked with the live agent that has it open.
    pub fn history_for(&self, cwd: &std::path::Path) -> Vec<AgentHistoryEntry> {
        let mut entries = self.history.list_for(cwd);
        for e in &mut entries {
            e.live_agent_id = self.live_claude_agent(&e.session_id);
        }
        if let Some(dir) = kiro_history::sessions_dir() {
            let kiro: Vec<_> = kiro_history::list_in(&dir, cwd)
                .into_iter()
                .filter(|k| !self.history.is_dismissed(&k.id) && !self.history.contains(&k.id))
                .collect();
            let live = self.live_kiro_sessions(cwd, &kiro);
            entries.extend(kiro.into_iter().map(|k| AgentHistoryEntry {
                live_agent_id: live.iter().find(|(sid, _)| *sid == k.id).map(|(_, a)| *a),
                session_id: k.id,
                backend: AgentBackendKind::Kiro,
                title: k.title,
                last_message: k.last_message,
                started_at: k.started_at,
                last_active_at: k.last_active_at,
                transports: vec![AgentTransport::Pty],
            }));
            entries.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
        }
        entries
    }

    /// Pair running Kiro agents in `cwd` with the conversations they have
    /// open. A resumed one is known; a fresh one gets the earliest unclaimed
    /// conversation created after it started, oldest agent first.
    fn live_kiro_sessions(
        &self,
        cwd: &std::path::Path,
        sessions: &[kiro_history::KiroSession],
    ) -> Vec<(String, AgentSessionId)> {
        let mut agents: Vec<(AgentSessionId, u64, Option<String>)> = self
            .kiro_meta
            .iter()
            .filter(|m| m.value().cwd == cwd && is_live(self, *m.key()))
            .map(|m| {
                (
                    *m.key(),
                    m.value().started_at,
                    m.value().resumed_from.clone(),
                )
            })
            .collect();
        agents.sort_by_key(|a| a.1);
        let mut out: Vec<(String, AgentSessionId)> = agents
            .iter()
            .filter_map(|(id, _, r)| Some((r.clone()?, *id)))
            .collect();
        let mut by_start: Vec<_> = sessions.iter().collect();
        by_start.sort_by_key(|s| s.started_at);
        for (id, started, resumed) in &agents {
            if resumed.is_some() {
                continue;
            }
            let pick = by_start.iter().find(|s| {
                s.started_at + KIRO_START_SLACK_MS >= *started
                    && !out.iter().any(|(sid, _)| *sid == s.id)
            });
            if let Some(s) = pick {
                out.push((s.id.clone(), *id));
            }
        }
        out
    }

    pub fn forget_history(&self, session_id: &str) {
        self.history.forget(session_id);
    }

    pub fn forget_worktree_history(&self, cwd: &std::path::Path) {
        self.history.forget_worktree(cwd);
    }

    fn drop_session_state(&self, id: &AgentSessionId) {
        super::notify::activity_changed();
        self.hook_sessions.remove(id);
        self.history_meta.remove(id);
        self.kiro_meta.remove(id);
    }

    pub fn list_for_worktree(&self, worktree_id: WorktreeId) -> Vec<AgentSession> {
        let mut sessions: Vec<AgentSession> = self
            .inner
            .iter()
            .filter(|e| e.value().session.worktree_id == worktree_id)
            .map(|e| e.value().session.clone())
            .chain(
                self.acp
                    .iter()
                    .filter(|e| e.value().session.worktree_id == worktree_id)
                    .map(|e| e.value().snapshot()),
            )
            .collect();
        sessions.sort_by_key(|s| s.started_at);
        sessions
    }

    pub fn status_snapshot(&self, id: AgentSessionId) -> Option<AgentStatus> {
        self.inner
            .get(&id)
            .map(|h| h.session.status.clone())
            .or_else(|| self.acp.get(&id).map(|h| h.status()))
    }

    pub fn transport_of(&self, id: AgentSessionId) -> Option<AgentTransport> {
        if self.inner.contains_key(&id) {
            Some(AgentTransport::Pty)
        } else if self.acp.contains_key(&id) {
            Some(AgentTransport::Acp)
        } else {
            None
        }
    }

    pub fn list_for_workspace<F: Fn(WorktreeId) -> bool>(
        &self,
        worktree_belongs: F,
    ) -> Vec<AgentSession> {
        self.inner
            .iter()
            .filter(|e| worktree_belongs(e.value().session.worktree_id))
            .map(|e| e.value().session.clone())
            .chain(
                self.acp
                    .iter()
                    .filter(|e| worktree_belongs(e.value().session.worktree_id))
                    .map(|e| e.value().snapshot()),
            )
            .collect()
    }

    /// Number of live (running or starting) agent sessions in a worktree.
    pub fn running_count_for_worktree(&self, worktree_id: WorktreeId) -> u32 {
        self.inner
            .iter()
            .filter(|e| {
                e.value().session.worktree_id == worktree_id
                    && matches!(
                        e.value().shared.lock().status,
                        AgentStatus::Running | AgentStatus::Starting
                    )
            })
            .count() as u32
            + self
                .acp
                .iter()
                .filter(|e| e.value().session.worktree_id == worktree_id && e.value().is_live())
                .count() as u32
    }

    /// Activity classification for a worktree, aggregated across **all** of
    /// its agents. Returns the most-alerting state: NeedsAttention > Working
    /// > Idle > Inactive. No running agents → Inactive.
    pub fn activity_for_worktree(&self, worktree_id: WorktreeId) -> AgentActivity {
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
            let act = self.session_activity(e.value(), &sh, now).0;
            best = max_severity(best, act);
        }
        for e in self.acp.iter() {
            if e.value().session.worktree_id == worktree_id {
                best = max_severity(best, e.value().activity());
            }
        }
        best
    }

    /// One live session's activity, plus its hook state for Claude.
    ///
    /// Claude sessions use hook events (see `agent::hooks`), which are
    /// authoritative; before the first event fires the agent is sitting at
    /// its prompt, so it reads as Idle. Other backends (Kiro, Codex) use a
    /// hybrid heuristic: byte timing for Working/Idle, plus a pattern scan
    /// for common confirmation prompts (`[y/N]`, "Press enter") that
    /// promotes Idle to NeedsAttention when a response is clearly pending.
    fn session_activity(
        &self,
        h: &AgentHandle,
        sh: &AgentShared,
        now: Instant,
    ) -> (AgentActivity, Option<HookSession>) {
        // Only Claude reports status over a PTY (its hooks); others' would
        // be guesses from output timing, so they aren't made.
        if !matches!(h.session.backend, AgentBackendKind::ClaudeCode) {
            return (AgentActivity::Untracked, None);
        }
        let Some(hook) = self
            .hook_sessions
            .get(&h.session.id)
            .map(|e| e.value().clone())
        else {
            return (AgentActivity::Idle, None);
        };
        // Claude doesn't always fire another hook after the user rejects a
        // permission prompt in the terminal, so `NeedsAttention` would stick.
        // Once someone has typed into the agent since the prompt appeared,
        // expire it after a grace period. An untouched prompt stays up:
        // the agent really is blocked.
        const NEEDS_ATTENTION_TTL: Duration = Duration::from_secs(45);
        let answered = sh.last_input.is_some_and(|t| t > hook.set_at);
        let act = if hook.activity == AgentActivity::NeedsAttention
            && answered
            && now.saturating_duration_since(hook.set_at) > NEEDS_ATTENTION_TTL
        {
            AgentActivity::Idle
        } else {
            hook.activity
        };
        (act, Some(hook))
    }

    /// Everything the agent board shows, for every session whose worktree
    /// passes `include`. Exited sessions are included as `Inactive` until
    /// their tab is closed.
    pub fn overview<F: Fn(WorktreeId) -> bool>(
        &self,
        include: F,
        diff_stats: impl Fn(WorktreeId) -> Option<crate::diff::DiffStats>,
    ) -> Vec<AgentOverview> {
        let now = Instant::now();
        let now_ms = now_millis();
        let at_ms =
            |t: Instant| now_ms.saturating_sub(now.saturating_duration_since(t).as_millis() as u64);
        let mut out = Vec::new();
        for e in self.inner.iter() {
            let h = e.value();
            if !include(h.session.worktree_id) {
                continue;
            }
            let sh = h.shared.lock();
            let mut session = h.session.clone();
            session.status = sh.status.clone();
            let live = matches!(sh.status, AgentStatus::Running | AgentStatus::Starting);
            let (activity, hook) = if live {
                self.session_activity(h, &sh, now)
            } else {
                (AgentActivity::Inactive, None)
            };
            let row = match hook {
                Some(hook) => {
                    let can_answer_inline = activity == AgentActivity::NeedsAttention
                        && matches!(hook.pending, Some(PendingPrompt::Permission { .. }))
                        && !sh.last_input.is_some_and(|t| t > hook.set_at);
                    AgentOverview {
                        activity,
                        changed_at: hook.changed_at,
                        title: hook.ai_title,
                        task: hook.task,
                        current_tool: hook.current_tool,
                        last_message: hook.last_message,
                        pending: if activity == AgentActivity::NeedsAttention {
                            hook.pending
                        } else {
                            None
                        },
                        can_answer_inline,
                        diff_stats: diff_stats(session.worktree_id),
                        session,
                    }
                }
                None => {
                    let changed_at = match activity {
                        AgentActivity::Inactive if !live => at_ms(sh.last_any_output),
                        _ if matches!(h.session.backend, AgentBackendKind::ClaudeCode) => {
                            h.session.started_at
                        }
                        _ => at_ms(sh.last_any_output),
                    };
                    AgentOverview {
                        activity,
                        changed_at,
                        title: None,
                        task: None,
                        current_tool: None,
                        last_message: None,
                        pending: None,
                        can_answer_inline: false,
                        diff_stats: diff_stats(session.worktree_id),
                        session,
                    }
                }
            };
            out.push(row);
        }
        for e in self.acp.iter() {
            let h = e.value();
            if include(h.session.worktree_id) {
                out.push(h.overview(diff_stats(h.session.worktree_id)));
            }
        }
        out.sort_by_key(|o| o.session.started_at);
        out
    }

    /// Kill every agent. Called from graceful shutdown.
    pub fn kill_all(&self) {
        let ids: Vec<_> = self.inner.iter().map(|e| *e.key()).collect();
        for id in ids {
            self.drop_session_state(&id);
            if let Some((_, h)) = self.inner.remove(&id) {
                let _ = h.child.lock().kill();
            }
        }
        let ids: Vec<_> = self.acp.iter().map(|e| *e.key()).collect();
        for id in ids {
            if let Some((_, h)) = self.acp.remove(&id) {
                h.kill();
            }
        }
    }
}

fn max_severity(a: AgentActivity, b: AgentActivity) -> AgentActivity {
    fn rank(a: AgentActivity) -> u8 {
        match a {
            AgentActivity::NeedsAttention => 4,
            AgentActivity::Working => 3,
            AgentActivity::Idle => 2,
            AgentActivity::Untracked => 1,
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
///
/// `channel` is `None` for headless launches (an agent spawning a sibling
/// worktree over MCP): output only fills the ring buffer until the user
/// opens that worktree and `AgentPane` adopts the session via `attach`.
///
/// `prompt` seeds the session's first turn as a positional arg. Claude Code
/// and Kiro sessions also get the treehouse MCP server injected — see
/// `crate::mcp::inject`.
///
/// `resume` reopens a saved conversation (`claude --resume <id>`,
/// `kiro-cli chat --resume-id <id>`); see `agent::history`.
#[allow(clippy::too_many_arguments)]
pub fn launch(
    app: &AppHandle,
    registry: &AgentRegistry,
    worktree_id: WorktreeId,
    cwd: PathBuf,
    backend: AgentBackendKind,
    argv_override: Option<Vec<String>>,
    prompt: Option<String>,
    resume: Option<String>,
    cols: u16,
    rows: u16,
    channel: Option<Channel<AgentEvent>>,
) -> AppResult<AgentSession> {
    if let Some(id) = &resume {
        if !matches!(
            backend,
            AgentBackendKind::ClaudeCode | AgentBackendKind::Kiro
        ) {
            return Err(AppError::Unknown(
                "Only Claude Code and Kiro sessions can be resumed.".into(),
            ));
        }
        if !history::is_valid_session_id(id) {
            return Err(AppError::Unknown(format!("invalid session id: {id}")));
        }
    }
    // Install Claude Code hooks in the worktree *before* spawning the
    // child, so the config is on disk when Claude reads settings.
    if matches!(backend, AgentBackendKind::ClaudeCode) {
        if let Err(e) = hooks::install(app, &cwd) {
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

    // Minted before spawn so the token can ride in argv; the handler checks
    // the session is still live, so a failed spawn just leaves a dead token.
    let session_id = AgentSessionId::new();
    let (mcp_config, kiro_home) = match crate::mcp::inject(app, backend, session_id, worktree_id) {
        Some(crate::mcp::Injection::ClaudeConfig(c)) => (Some(c), None),
        Some(crate::mcp::Injection::KiroHome(h)) => (None, Some(h)),
        None => (None, None),
    };
    let spawn_argv = build_spawn_argv(
        backend,
        &argv,
        mcp_config.as_deref(),
        resume.as_deref(),
        prompt.as_deref(),
    );

    let mut cmd = CommandBuilder::new(&spawn_argv[0]);
    for arg in spawn_argv.iter().skip(1) {
        cmd.arg(arg);
    }
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    if let Ok(ct) = std::env::var("COLORTERM") {
        cmd.env("COLORTERM", ct);
    }
    // Hook commands key their state files by this; see `agent::hooks`.
    cmd.env(hooks::SESSION_ENV, session_id.to_string());
    if let Some(home) = &kiro_home {
        cmd.env(crate::mcp::KIRO_HOME_ENV, home);
    }

    let child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            if let Some(home) = &kiro_home {
                crate::mcp::remove_kiro_home(home);
            }
            return Err(AppError::Unknown(format!("spawn agent: {e}")));
        }
    };

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::Unknown(format!("clone reader: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::Unknown(format!("take writer: {e}")))?;

    let session = AgentSession {
        id: session_id,
        worktree_id,
        backend,
        argv: argv.clone(),
        started_at: now_millis(),
        cols,
        rows,
        status: AgentStatus::Running,
        resumed: resume.is_some(),
        transport: AgentTransport::Pty,
    };

    let shared = Arc::new(Mutex::new(AgentShared {
        ring: VecDeque::with_capacity(RING_MAX_BYTES / 16),
        channel: channel.clone(),
        status: AgentStatus::Running,
        last_any_output: Instant::now(),
        last_input: None,
    }));

    // Announce "Running" immediately so the UI can swap state.
    if let Some(ch) = &channel {
        let _ = ch.send(AgentEvent::Status {
            status: AgentStatus::Running,
        });
    }

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
                        let mut sh = shared_for_reader.lock();
                        sh.ring.extend(chunk.iter().copied());
                        let excess = sh.ring.len().saturating_sub(RING_MAX_BYTES);
                        if excess > 0 {
                            sh.ring.drain(..excess);
                        }
                        sh.last_any_output = Instant::now();
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
            // EOF means the child is gone, so its shadow home can go too.
            if let Some(home) = &kiro_home {
                crate::mcp::remove_kiro_home(home);
            }
            let exit = AgentStatus::Exited { code: None };
            let mut sh = shared_for_reader.lock();
            sh.status = exit.clone();
            if let Some(ch) = sh.channel.as_ref() {
                let _ = ch.send(AgentEvent::Status { status: exit });
            }
            super::notify::activity_changed();
            tracing::info!(%session_id, "agent stream closed");
        })
        .map_err(|e| AppError::Unknown(format!("spawn agent reader: {e}")))?;

    if matches!(backend, AgentBackendKind::Kiro) {
        registry.kiro_meta.insert(
            session_id,
            KiroMeta {
                cwd: cwd.clone(),
                started_at: session.started_at,
                resumed_from: resume.clone(),
            },
        );
    }
    if matches!(backend, AgentBackendKind::ClaudeCode) {
        if let Some(cid) = &resume {
            // Seed only: if a hook already landed, it's newer than history.
            if let Some(turn) = registry.history.last_turn(cid) {
                registry.hook_sessions.entry(session_id).or_insert_with(|| {
                    HookSession::resumed(cid.clone(), turn, now_millis(), Instant::now())
                });
            }
        }
        registry.history_meta.insert(
            session_id,
            HistoryMeta {
                cwd: cwd.clone(),
                resumed_from: resume,
            },
        );
    }
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
    super::notify::activity_changed();

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
    if registry.acp.contains_key(&id) {
        return acp::attach(registry, id, channel);
    }
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

pub fn write_stdin(registry: &AgentRegistry, id: AgentSessionId, data: &[u8]) -> AppResult<()> {
    if registry.acp.contains_key(&id) {
        return Err(AppError::Unknown(
            "ACP agents take prompts, not keystrokes.".into(),
        ));
    }
    let handle = registry
        .inner
        .get(&id)
        .ok_or_else(|| AppError::Unknown(format!("unknown agent: {id}")))?;
    // Only typing counts as answering a prompt. xterm also writes on its
    // own — focus in/out when the pane is clicked, mouse reports, replies
    // to queries replayed on attach — and those must not expire
    // `NeedsAttention` (see `session_activity`).
    if !is_terminal_report(data) {
        handle.shared.lock().last_input = Some(Instant::now());
    }
    let mut w = handle.writer.lock();
    w.write_all(data)
        .map_err(|e| AppError::Io(format!("agent write: {e}")))?;
    w.flush()
        .map_err(|e| AppError::Io(format!("agent flush: {e}")))?;
    Ok(())
}

/// True when `data` is made up entirely of sequences the terminal emulator
/// generates itself rather than keystrokes: focus events (`CSI I` / `CSI O`),
/// SGR and X10 mouse reports, cursor-position / device-attribute / mode
/// replies, and OSC / DCS query replies. A bare `ESC` (reject a prompt) or an
/// arrow key (`CSI A`) is not a report.
fn is_terminal_report(data: &[u8]) -> bool {
    let mut i = 0;
    while i < data.len() {
        match report_len(&data[i..]) {
            Some(n) => i += n,
            None => return false,
        }
    }
    i > 0
}

/// Length of the terminal report at the start of `d`, if there is one.
fn report_len(d: &[u8]) -> Option<usize> {
    match d {
        [0x1b, b'[', b'I' | b'O', ..] => Some(3),
        // X10 mouse: CSI M Cb Cx Cy.
        [0x1b, b'[', b'M', _, _, _, ..] => Some(6),
        [0x1b, b'[', rest @ ..] => {
            let end = rest.iter().position(|b| (0x40..=0x7e).contains(b))?;
            let params = &rest[..end];
            let fin = rest[end];
            let ok = match fin {
                // SGR mouse: CSI < b ; x ; y M|m
                b'M' | b'm' => params.first() == Some(&b'<'),
                // Cursor position report: CSI row ; col R
                b'R' => {
                    !params.is_empty() && params.iter().all(|b| b.is_ascii_digit() || *b == b';')
                }
                // Device attributes: CSI ? … c / CSI > … c
                b'c' => matches!(params.first(), Some(b'?' | b'>')),
                // Mode report (DECRPM): CSI ? … $ y
                b'y' => params.last() == Some(&b'$'),
                _ => false,
            };
            ok.then_some(2 + end + 1)
        }
        // OSC / DCS replies (colour queries, XTVERSION), ended by BEL or ST.
        [0x1b, b']' | b'P', rest @ ..] => {
            for (j, b) in rest.iter().enumerate() {
                if *b == 0x07 {
                    return Some(2 + j + 1);
                }
                if *b == 0x1b && rest.get(j + 1) == Some(&b'\\') {
                    return Some(2 + j + 2);
                }
            }
            None
        }
        _ => None,
    }
}

/// Answer a Claude permission dialog without opening the agent: Enter picks
/// the dialog's default ("Yes"), Esc rejects it. Refuses unless the board
/// would offer the buttons right now (`can_answer_inline`), so a stale
/// click can't press Enter into whatever the agent shows next.
pub fn respond_permission(
    registry: &AgentRegistry,
    id: AgentSessionId,
    allow: bool,
) -> AppResult<()> {
    if registry.acp.contains_key(&id) {
        return acp::respond_permission_bool(registry, id, allow);
    }
    let answerable = registry
        .overview(|_| true, |_| None)
        .into_iter()
        .any(|o| o.session.id == id && o.can_answer_inline);
    if !answerable {
        return Err(AppError::Unknown(
            "This agent is no longer waiting on that permission prompt. Open the agent to see what it's doing."
                .into(),
        ));
    }
    write_stdin(registry, id, if allow { b"\r" } else { b"\x1b" })?;
    let now = Instant::now();
    super::notify::activity_changed();
    if let Some(mut hook) = registry.hook_sessions.get_mut(&id) {
        if allow {
            // PreToolUse/PostToolUse will confirm; show it moving meanwhile.
            hook.activity = AgentActivity::Working;
            hook.changed_at = now_millis();
            hook.set_at = now;
            hook.pending = None;
        } else {
            // Rejecting leaves Claude waiting for instructions.
            hook.pending = Some(PendingPrompt::Input {
                message: Some("Denied. Tell the agent what to do instead.".into()),
            });
        }
    }
    Ok(())
}

/// Bracketed-paste markers: the TUI takes the text as one paste, so its
/// newlines don't each submit.
const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

/// Submit `text` as the agent's next prompt: a bracketed paste plus Enter
/// into a PTY agent's TUI, or `session/prompt` for an ACP agent.
pub fn submit_prompt(registry: &AgentRegistry, id: AgentSessionId, text: &str) -> AppResult<()> {
    match registry.transport_of(id) {
        Some(AgentTransport::Acp) => acp::send_prompt(registry, id, text, &[], false),
        Some(AgentTransport::Pty) => {
            let mut bytes = PASTE_START.to_vec();
            bytes.extend_from_slice(text.as_bytes());
            bytes.extend_from_slice(PASTE_END);
            bytes.push(b'\r');
            write_stdin(registry, id, &bytes)
        }
        None => Err(AppError::Unknown(format!("unknown agent: {id}"))),
    }
}

pub fn resize(registry: &AgentRegistry, id: AgentSessionId, cols: u16, rows: u16) -> AppResult<()> {
    if registry.acp.contains_key(&id) {
        return Ok(());
    }
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

/// Final argv for the child: the user-visible `argv` (what `AgentSession`
/// records and tab labels derive from) plus injected flags. A seeded prompt
/// goes last behind `--`, because Claude's `--mcp-config <configs...>` is
/// variadic and would otherwise swallow it. Kiro only takes a prompt or a
/// resume on `kiro-cli chat`, so that's inserted when the command doesn't
/// name it.
fn build_spawn_argv(
    backend: AgentBackendKind,
    argv: &[String],
    mcp_config: Option<&str>,
    resume: Option<&str>,
    prompt: Option<&str>,
) -> Vec<String> {
    let mut out = argv.to_vec();
    let kiro = matches!(backend, AgentBackendKind::Kiro);
    let prompt = prompt.map(str::trim).filter(|p| !p.is_empty());
    if kiro && (resume.is_some() || prompt.is_some()) && !out.iter().skip(1).any(|a| a == "chat") {
        out.insert(1.min(out.len()), "chat".into());
    }
    if let Some(id) = resume {
        out.push(if kiro { "--resume-id" } else { "--resume" }.into());
        out.push(id.into());
    }
    if let Some(cfg) = mcp_config {
        out.push("--mcp-config".into());
        out.push(cfg.into());
    }
    if let Some(p) = prompt {
        out.push("--".into());
        out.push(p.into());
    }
    out
}

/// `true` while the session exists and its child hasn't exited.
pub fn is_live(registry: &AgentRegistry, id: AgentSessionId) -> bool {
    registry.inner.get(&id).is_some_and(|h| {
        matches!(
            h.shared.lock().status,
            AgentStatus::Running | AgentStatus::Starting
        )
    }) || registry.acp.get(&id).is_some_and(|h| h.is_live())
}

pub fn kill(registry: &AgentRegistry, id: AgentSessionId) {
    registry.drop_session_state(&id);
    if let Some((_, handle)) = registry.inner.remove(&id) {
        let _ = handle.child.lock().kill();
        tracing::info!(%id, "killed agent");
    }
    if let Some((_, handle)) = registry.acp.remove(&id) {
        handle.kill();
        tracing::info!(%id, "killed acp agent");
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
        registry.drop_session_state(&id);
        if let Some((_, handle)) = registry.inner.remove(&id) {
            let _ = handle.child.lock().kill();
            tracing::info!(%id, %worktree_id, "killed agent for removed worktree");
        }
    }
    let ids: Vec<_> = registry
        .acp
        .iter()
        .filter(|e| e.value().session.worktree_id == worktree_id)
        .map(|e| *e.key())
        .collect();
    for id in ids {
        if let Some((_, handle)) = registry.acp.remove(&id) {
            handle.kill();
            tracing::info!(%id, %worktree_id, "killed acp agent for removed worktree");
        }
    }
}

pub(crate) fn now_millis() -> u64 {
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
        let is_agent_row =
            line.starts_with("* ") || (line.starts_with("  ") && !line.starts_with("   "));
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

    #[test]
    fn terminal_reports_are_not_user_input() {
        for r in [
            &b"\x1b[I"[..],
            b"\x1b[O",
            b"\x1b[<0;12;5M\x1b[<0;12;5m",
            b"\x1b[M #!",
            b"\x1b[24;80R",
            b"\x1b[?1;2c",
            b"\x1b[>0;276;0c",
            b"\x1b[?2026;2$y",
            b"\x1b]11;rgb:0000/0000/0000\x07",
            b"\x1bP>|xterm.js(5.5.0)\x1b\\",
            b"\x1b[I\x1b[24;80R",
        ] {
            assert!(is_terminal_report(r), "{r:?}");
        }
        for k in [
            &b""[..],
            b"\x1b",
            b"\r",
            b"y",
            b"\x1b[A",
            b"\x1b[B\r",
            b"\x1b\r",
            b"\x1b[Ihello",
            b"\x1b[200~pasted\x1b[201~",
        ] {
            assert!(!is_terminal_report(k), "{k:?}");
        }
    }

    #[test]
    fn spawn_argv_puts_prompt_after_variadic_mcp_config() {
        let argv = vec!["claude".to_string(), "--agent".into(), "x".into()];
        assert_eq!(
            build_spawn_argv(
                AgentBackendKind::ClaudeCode,
                &argv,
                Some("{}"),
                None,
                Some("  do it  ")
            ),
            vec![
                "claude",
                "--agent",
                "x",
                "--mcp-config",
                "{}",
                "--",
                "do it"
            ]
        );
        // No extras → argv untouched; blank prompt ignored.
        assert_eq!(
            build_spawn_argv(AgentBackendKind::ClaudeCode, &argv, None, None, Some(" ")),
            argv
        );
        // Kiro takes the prompt on `chat`, added when the command lacks it.
        assert_eq!(
            build_spawn_argv(
                AgentBackendKind::Kiro,
                &["kiro-cli".into()],
                None,
                None,
                Some("hi")
            ),
            vec!["kiro-cli", "chat", "--", "hi"]
        );
        let kiro = vec![
            "kiro-cli".to_string(),
            "chat".into(),
            "--agent".into(),
            "x".into(),
        ];
        assert_eq!(
            build_spawn_argv(AgentBackendKind::Kiro, &kiro, None, None, Some("hi")),
            vec!["kiro-cli", "chat", "--agent", "x", "--", "hi"]
        );
        assert_eq!(
            build_spawn_argv(
                AgentBackendKind::Kiro,
                &["kiro-cli".into()],
                None,
                None,
                None
            ),
            vec!["kiro-cli"]
        );
    }

    #[test]
    fn spawn_argv_resumes_before_mcp_config() {
        assert_eq!(
            build_spawn_argv(
                AgentBackendKind::ClaudeCode,
                &["claude".into()],
                Some("{}"),
                Some("abc-123"),
                None,
            ),
            vec!["claude", "--resume", "abc-123", "--mcp-config", "{}"]
        );
    }

    #[test]
    fn kiro_resume_goes_through_chat() {
        assert_eq!(
            build_spawn_argv(
                AgentBackendKind::Kiro,
                &["kiro-cli".into(), "--agent".into(), "x".into()],
                None,
                Some("abc-123"),
                None,
            ),
            vec!["kiro-cli", "chat", "--agent", "x", "--resume-id", "abc-123"]
        );
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
