//! Agent Client Protocol transport: an agent spoken to as JSON-RPC over
//! stdio (<https://agentclientprotocol.com>) instead of driven through a PTY.
//! Runs alongside `supervisor` — sessions live in `AgentRegistry::acp`, so
//! the board, sidebar, MCP token checks and shutdown see both transports.
//!
//! Lifecycle of one session:
//! 1. Spawn the backend's adapter (see `adapter`: a `[agent.acp]` override,
//!    else a treehouse-managed pinned install) in its own process group,
//!    cwd = the worktree.
//! 2. `initialize` (we advertise no `fs/*` / `terminal/*` capabilities), then
//!    `session/new` with the treehouse MCP server when the agent takes HTTP
//!    MCP servers. Prompts sent before this finishes are queued.
//! 3. `session/prompt` per prompt; `session/update` notifications fold into
//!    an [`AcpView`] (overview fields) and a transcript event log.
//! 4. `session/request_permission` parks as the view's pending prompt until
//!    a respond command answers it by option id; `session/cancel` cancels.
//!
//! The event log is the ACP analogue of the PTY ring buffer: `attach`
//! replays it into a fresh Channel before live events resume.

pub mod adapter;
pub mod prompt;
pub mod question;
pub mod rpc;
pub mod view;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol_schema::v1::{
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionModeState, SessionUpdate,
};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::util::errors::{AppError, AppResult};
use crate::util::ids::{AgentSessionId, WorktreeId};

use super::history::{AgentHistory, LastTurn};
use super::supervisor::{now_millis, AgentRegistry};
use super::{
    AgentActivity, AgentBackendKind, AgentEvent, AgentOverview, AgentSession, AgentStatus,
    AgentTransport,
};
use rpc::{Incoming, RpcConn, AUTH_REQUIRED, METHOD_NOT_FOUND};
pub use prompt::AcpAttachment;
pub use view::{AcpEvent, AcpView};

/// Events kept for replay. Text chunks and tool updates coalesce (see
/// `push_log`), so this is turns' worth of transcript, not raw messages.
const LOG_MAX: usize = 20_000;
/// How far back `push_log` looks for an earlier event of the same tool call
/// to replace in place.
const TOOL_REPLACE_WINDOW: usize = 256;
/// Adapter stderr lines kept for error messages (auth failures, a missing
/// `npx`, a crash on startup).
const STDERR_TAIL: usize = 20;

struct AcpShared {
    view: AcpView,
    log: Vec<AcpEvent>,
    channel: Option<Channel<AgentEvent>>,
    status: AgentStatus,
    /// Prompts (content blocks) sent before the session was up.
    queued: Vec<Vec<Value>>,
    /// `session/prompt` requests awaiting their response.
    in_flight: u32,
    /// Prompts that interrupt the running turn: held until the cancelled
    /// turn settles (see `send_prompt`), so the cancel can't swallow them.
    redirects: Vec<Vec<Value>>,
    /// Permission requests behind the one in `view.pending` (parallel
    /// subagents can ask at once); promoted in order.
    waiting: VecDeque<(Value, RequestPermissionRequest)>,
    stderr_tail: VecDeque<String>,
    /// Set by `kill`, so the teardown that follows isn't reported as a crash.
    killed: bool,
    exited_at: Option<u64>,
}

impl AcpShared {
    fn emit(&mut self, ev: AcpEvent) {
        if let Some(ch) = &self.channel {
            if ch.send(AgentEvent::Acp { event: ev.clone() }).is_err() {
                self.channel = None;
            }
        }
        push_log(&mut self.log, ev);
    }

    /// Stream a state event (`Commands`, `Usage`) without logging it; the
    /// view holds the latest and `attach` sends it after the log.
    fn emit_state(&mut self, ev: AcpEvent) {
        if let Some(ch) = &self.channel {
            if ch.send(AgentEvent::Acp { event: ev }).is_err() {
                self.channel = None;
            }
        }
    }

    /// Route a view-produced event to the log or the state stream.
    fn emit_any(&mut self, ev: AcpEvent) {
        match ev {
            AcpEvent::Commands { .. } | AcpEvent::Usage { .. } | AcpEvent::Config { .. } => {
                self.emit_state(ev)
            }
            ev => self.emit(ev),
        }
    }

    fn set_status(&mut self, status: AgentStatus) {
        self.status = status.clone();
        if let Some(ch) = &self.channel {
            let _ = ch.send(AgentEvent::Status { status });
        }
    }

    fn live(&self) -> bool {
        matches!(self.status, AgentStatus::Running | AgentStatus::Starting)
    }

    fn stderr_summary(&self) -> Option<String> {
        if self.stderr_tail.is_empty() {
            return None;
        }
        Some(self.stderr_tail.iter().cloned().collect::<Vec<_>>().join("\n"))
    }

    /// Surface the next queued permission request, if the slot is free.
    fn promote_waiting(&mut self) {
        if self.view.pending.is_some() {
            return;
        }
        if let Some((id, req)) = self.waiting.pop_front() {
            let ev = self.view.permission_requested(id, req, now_millis());
            self.emit(ev);
        }
    }
}

/// Append `ev`, merging it into the log's tail where the pane would anyway:
/// consecutive text chunks become one, and a tool call's newer state
/// replaces its older one.
fn push_log(log: &mut Vec<AcpEvent>, ev: AcpEvent) {
    match (log.last_mut(), &ev) {
        (Some(AcpEvent::AgentText { text }), AcpEvent::AgentText { text: more })
        | (Some(AcpEvent::UserText { text }), AcpEvent::UserText { text: more })
        | (Some(AcpEvent::Thought { text }), AcpEvent::Thought { text: more }) => {
            text.push_str(more);
            return;
        }
        _ => {}
    }
    if let AcpEvent::Tool { tool } = &ev {
        let start = log.len().saturating_sub(TOOL_REPLACE_WINDOW);
        if let Some(slot) = log[start..]
            .iter_mut()
            .rev()
            .find(|e| matches!(e, AcpEvent::Tool { tool: t } if t.id == tool.id))
        {
            *slot = ev;
            return;
        }
    }
    log.push(ev);
    if log.len() > LOG_MAX {
        log.drain(..LOG_MAX / 10);
    }
}

/// Registry entry for one ACP session.
pub struct AcpHandle {
    pub session: AgentSession,
    shared: Arc<Mutex<AcpShared>>,
    conn: Arc<RpcConn>,
    /// Adapter pid = its process group id (spawned with `process_group(0)`),
    /// so `kill` reaches the node/CLI children too.
    pid: Option<u32>,
    cwd: PathBuf,
}

impl AcpHandle {
    pub fn status(&self) -> AgentStatus {
        self.shared.lock().status.clone()
    }

    pub fn is_live(&self) -> bool {
        self.shared.lock().live()
    }

    pub fn snapshot(&self) -> AgentSession {
        let mut s = self.session.clone();
        s.status = self.status();
        s
    }

    pub fn activity(&self) -> AgentActivity {
        let sh = self.shared.lock();
        if sh.live() {
            sh.view.activity()
        } else {
            AgentActivity::Inactive
        }
    }

    /// The agent's own session id — for Claude, the conversation id
    /// `claude --resume` takes (the adapter persists the same transcript).
    pub fn agent_session_id(&self) -> Option<String> {
        self.shared.lock().view.session_id.clone()
    }

    pub fn overview(&self, diff_stats: Option<crate::diff::DiffStats>) -> AgentOverview {
        let sh = self.shared.lock();
        let mut session = self.session.clone();
        session.status = sh.status.clone();
        let live = sh.live();
        let v = &sh.view;
        let pending = if live { v.pending_prompt() } else { None };
        AgentOverview {
            activity: if live {
                v.activity()
            } else {
                AgentActivity::Inactive
            },
            changed_at: match sh.exited_at {
                Some(t) if !live => t,
                _ => v.changed_at,
            },
            title: v.title.clone(),
            task: v.task.clone(),
            current_tool: v.current_tool.clone(),
            last_message: v.last_message.clone(),
            can_answer_inline: pending.is_some(),
            pending,
            diff_stats,
            session,
        }
    }

    pub fn kill(&self) {
        {
            let mut sh = self.shared.lock();
            if sh.killed {
                return;
            }
            sh.killed = true;
        }
        if let Some(pid) = self.pid {
            kill_group(pid);
        }
    }
}

/// TERM the adapter's process group, then KILL whatever ignored it.
fn kill_group(pid: u32) {
    let group = format!("-{pid}");
    let _ = std::process::Command::new("/bin/kill")
        .args(["-TERM", "--", &group])
        .stderr(Stdio::null())
        .status();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let _ = std::process::Command::new("/bin/kill")
            .args(["-KILL", "--", &group])
            .stderr(Stdio::null())
            .status();
    });
}

/// Context the background tasks need beyond the shared state.
#[derive(Clone)]
struct Ctx {
    id: AgentSessionId,
    backend: AgentBackendKind,
    cwd: PathBuf,
    shared: Arc<Mutex<AcpShared>>,
    conn: Arc<RpcConn>,
    history: Arc<AgentHistory>,
    pid: Option<u32>,
    /// The CLI path handed to the adapter, if any (see `adapter`).
    cli: Option<String>,
    /// The saved conversation this session reopened (`session/load`).
    resumed_from: Option<String>,
}

/// Spawn `argv` as an ACP agent in `cwd` and start the handshake. Returns
/// as soon as the process is up; the handshake, and any seeded `prompt`,
/// continue in the background and stream over `channel`.
#[allow(clippy::too_many_arguments)]
pub fn launch(
    app: &AppHandle,
    registry: &AgentRegistry,
    worktree_id: WorktreeId,
    cwd: PathBuf,
    backend: AgentBackendKind,
    argv: Vec<String>,
    env: Vec<(String, String)>,
    prompt: Option<String>,
    resume: Option<String>,
    channel: Option<Channel<AgentEvent>>,
) -> AppResult<AgentSession> {
    if argv.is_empty() {
        return Err(AppError::Unknown("empty ACP adapter command".into()));
    }
    let session_id = AgentSessionId::new();
    // Minted before spawn, like PTY launches; offered in `session/new` only
    // if the agent says it takes HTTP MCP servers.
    let mcp = crate::mcp::http_server(app, session_id, worktree_id);

    let mut cmd = tokio::process::Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        // Treehouse's Claude hooks may be installed in this worktree by a
        // PTY agent; without the session var they no-op instead of
        // misfiling this agent's events under another session.
        .env_remove(super::hooks::SESSION_ENV)
        .envs(env.iter().map(|(k, v)| (k, v)));
    let mut child = cmd.spawn().map_err(|e| {
        AppError::Unknown(format!("spawn ACP adapter `{}`: {e}", argv.join(" ")))
    })?;
    let pid = child.id();
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err(AppError::Unknown("ACP adapter stdio unavailable".into()));
    };
    let (conn, incoming) = RpcConn::start(stdout, stdin);

    let now = now_millis();
    let session = AgentSession {
        id: session_id,
        worktree_id,
        backend,
        argv: argv.clone(),
        started_at: now,
        cols: 0,
        rows: 0,
        status: AgentStatus::Running,
        resumed: resume.is_some(),
        transport: AgentTransport::Acp,
    };
    let mut shared = AcpShared {
        view: AcpView::new(now),
        log: Vec::new(),
        channel,
        status: AgentStatus::Running,
        queued: Vec::new(),
        in_flight: 0,
        redirects: Vec::new(),
        waiting: VecDeque::new(),
        stderr_tail: VecDeque::new(),
        killed: false,
        exited_at: None,
    };
    shared.set_status(AgentStatus::Running);
    if let Some(p) = prompt.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        let ev = shared.view.prompt_started(&p, vec![], now);
        shared.emit(ev);
        shared.queued.push(vec![json!({ "type": "text", "text": p })]);
    }
    let shared = Arc::new(Mutex::new(shared));
    let ctx = Ctx {
        id: session_id,
        backend,
        cwd: cwd.clone(),
        shared: shared.clone(),
        conn: conn.clone(),
        history: registry.history_handle(),
        pid,
        cli: env
            .iter()
            .find(|(k, _)| k == adapter::CLAUDE_EXECUTABLE_ENV)
            .map(|(_, v)| v.clone()),
        resumed_from: resume,
    };

    registry.acp.insert(
        session_id,
        AcpHandle {
            session: session.clone(),
            shared,
            conn,
            pid,
            cwd,
        },
    );

    tauri::async_runtime::spawn(read_stderr(ctx.clone(), stderr));
    tauri::async_runtime::spawn(handle_incoming(ctx.clone(), incoming));
    tauri::async_runtime::spawn(handshake(ctx.clone(), mcp));
    tauri::async_runtime::spawn(async move {
        let code = child.wait().await.ok().and_then(|s| s.code());
        let mut sh = ctx.shared.lock();
        let never_ready = sh.view.session_id.is_none();
        if !sh.killed && never_ready && !matches!(sh.status, AgentStatus::Crashed { .. }) {
            let mut message = format!("ACP adapter exited (code {code:?}) before the session started.");
            if let Some(tail) = sh.stderr_summary() {
                message.push_str("\n\n");
                message.push_str(&tail);
            }
            sh.emit(AcpEvent::Error { message });
        }
        sh.exited_at = Some(now_millis());
        if sh.live() {
            sh.set_status(AgentStatus::Exited { code });
        }
        tracing::info!(id = %ctx.id, ?code, "acp agent exited");
    });

    tracing::info!(%session_id, %worktree_id, ?argv, ?env, "launched acp agent");
    Ok(session)
}

async fn read_stderr(ctx: Ctx, stderr: tokio::process::ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::debug!(id = %ctx.id, "acp stderr: {line}");
        let mut sh = ctx.shared.lock();
        sh.stderr_tail.push_back(line);
        if sh.stderr_tail.len() > STDERR_TAIL {
            sh.stderr_tail.pop_front();
        }
    }
}

async fn handshake(ctx: Ctx, mcp: Option<(String, String)>) {
    if let Err(message) = try_handshake(&ctx, mcp).await {
        tracing::warn!(id = %ctx.id, %message, "acp handshake failed");
        let mut sh = ctx.shared.lock();
        if sh.killed {
            return;
        }
        let mut full = message.clone();
        if let Some(tail) = sh.stderr_summary() {
            full.push_str("\n\n");
            full.push_str(&tail);
        }
        sh.emit(AcpEvent::Error { message: full });
        sh.set_status(AgentStatus::Crashed { message });
        drop(sh);
        if let Some(pid) = ctx.pid {
            kill_group(pid);
        }
    }
}

async fn try_handshake(ctx: &Ctx, mcp: Option<(String, String)>) -> Result<(), String> {
    let init = ctx
        .conn
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                // No fs/* or terminal/*: the agent uses its own tools on disk.
                // Form elicitations: questions render as forms in the pane
                // (Claude's adapter only enables AskUserQuestion with this).
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                    "elicitation": { "form": {} },
                },
                "clientInfo": {
                    "name": "treehouse",
                    "title": "treehouse",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            }),
        )
        .await
        .map_err(|e| format!("ACP initialize failed: {e}"))?;
    let agent_name = init
        .pointer("/agentInfo/title")
        .or_else(|| init.pointer("/agentInfo/name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let cap = |ptr: &str| init.pointer(ptr).and_then(Value::as_bool).unwrap_or(false);
    let takes_http = cap("/agentCapabilities/mcpCapabilities/http");
    ctx.shared.lock().view.caps = view::PromptCaps {
        image: cap("/agentCapabilities/promptCapabilities/image"),
        embedded_context: cap("/agentCapabilities/promptCapabilities/embeddedContext"),
    };
    let mcp_servers = match (&mcp, takes_http) {
        (Some((url, token)), true) => json!([{
            "type": "http",
            "name": crate::mcp::SERVER_NAME,
            "url": url,
            "headers": [{ "name": "Authorization", "value": format!("Bearer {token}") }],
        }]),
        _ => json!([]),
    };
    let (new, sid) = match &ctx.resumed_from {
        None => {
            let new = ctx
                .conn
                .request(
                    "session/new",
                    json!({ "cwd": ctx.cwd, "mcpServers": mcp_servers }),
                )
                .await
                .map_err(|e| {
                    if e.code == AUTH_REQUIRED {
                        auth_hint(&e)
                    } else {
                        format!("ACP session/new failed: {e}")
                    }
                })?;
            let sid = new
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or("ACP session/new returned no sessionId")?
                .to_string();
            (new, sid)
        }
        Some(id) => {
            // `session/load` replays the conversation as updates before it
            // returns; `session/resume` reopens it without a replay.
            let method = if cap("/agentCapabilities/loadSession") {
                "session/load"
            } else if init
                .pointer("/agentCapabilities/sessionCapabilities/resume")
                .is_some_and(|v| !v.is_null())
            {
                "session/resume"
            } else {
                return Err("This agent can't reopen saved conversations over ACP.".into());
            };
            ctx.shared.lock().view.replaying = method == "session/load";
            let res = ctx
                .conn
                .request(
                    method,
                    json!({ "sessionId": id, "cwd": ctx.cwd, "mcpServers": mcp_servers }),
                )
                .await;
            ctx.shared.lock().view.replay_finished(now_millis());
            let res = res.map_err(|e| {
                if e.code == AUTH_REQUIRED {
                    auth_hint(&e)
                } else {
                    format!("Couldn't reopen the conversation ({method}): {e}")
                }
            })?;
            (res, id.clone())
        }
    };

    let modes = new
        .get("modes")
        .cloned()
        .and_then(|m| serde_json::from_value::<SessionModeState>(m).ok());
    let queued = {
        let mut sh = ctx.shared.lock();
        sh.view.session_id = Some(sid.clone());
        if let Some(ev) = modes.and_then(|m| sh.view.set_modes(m)) {
            sh.emit(ev);
        }
        if let Some(ev) = new.get("configOptions").and_then(|c| sh.view.set_config(c)) {
            sh.emit_state(ev);
        }
        if let Some(ev) = new.get("models").and_then(|m| sh.view.set_legacy_models(m)) {
            sh.emit_state(ev);
        }
        let accepts_images = sh.view.caps.image;
        sh.emit(AcpEvent::Ready {
            session_id: sid.clone(),
            agent_name,
            mcp_attached: takes_http && mcp.is_some(),
            cli: ctx.cli.clone(),
            accepts_images,
        });
        std::mem::take(&mut sh.queued)
    };
    tracing::info!(id = %ctx.id, acp_session = %sid, "acp session ready");
    for blocks in queued {
        spawn_prompt(ctx.clone(), sid.clone(), blocks);
    }
    Ok(())
}

/// Claude's adapter accepts `session/new` signed out and fails the first
/// `session/prompt` instead, so both paths share this.
fn auth_hint(e: &rpc::RpcError) -> String {
    format!(
        "The agent needs you to sign in ({}). Log in once in a terminal \
         (e.g. run `claude` and use /login), then send again.",
        e.message
    )
}

async fn handle_incoming(ctx: Ctx, mut incoming: tokio::sync::mpsc::UnboundedReceiver<Incoming>) {
    while let Some(msg) = incoming.recv().await {
        match msg {
            Incoming::Notification { method, mut params } if method == "session/update" => {
                let raw = params.get_mut("update").map(Value::take).unwrap_or(Value::Null);
                match serde_json::from_value::<SessionUpdate>(raw) {
                    Ok(update) => {
                        let mut sh = ctx.shared.lock();
                        if let Some(ev) = sh.view.apply_update(update, now_millis()) {
                            sh.emit_any(ev);
                        }
                    }
                    // Newer agents send update kinds this schema predates.
                    Err(e) => tracing::trace!(id = %ctx.id, ?e, "acp: skipped session/update"),
                }
            }
            // Vendor extensions (Kiro's `_kiro.dev/*` commands, MCP and
            // compaction events) aren't handled yet; log their shape.
            Incoming::Notification { method, params } => {
                let mut shape = params.to_string();
                shape.truncate(2000);
                tracing::debug!(id = %ctx.id, %method, params = %shape, "acp: unhandled notification");
            }
            Incoming::Request { id, method, params } if method == "session/request_permission" => {
                match serde_json::from_value::<RequestPermissionRequest>(params) {
                    Ok(req) => {
                        let mut sh = ctx.shared.lock();
                        sh.waiting.push_back((id, req));
                        sh.promote_waiting();
                    }
                    Err(e) => ctx.conn.respond_error(id, -32602, &format!("invalid params: {e}")),
                }
            }
            Incoming::Request { id, method, params } if method == "elicitation/create" => {
                let mut sh = ctx.shared.lock();
                let parsed = question::parse_question(view::id_string(&id), &params);
                match parsed {
                    // One question at a time; a second is declined.
                    Some(q) if sh.view.question.is_none() => {
                        let ev = sh.view.question_asked(id, q, now_millis());
                        sh.emit(ev);
                    }
                    _ => ctx.conn.respond(id, json!({ "action": "decline" })),
                }
            }
            Incoming::Request { id, method, .. } => {
                tracing::debug!(id = %ctx.id, %method, "acp: unsupported client method");
                ctx.conn
                    .respond_error(id, METHOD_NOT_FOUND, "not supported by treehouse");
            }
        }
    }
}

fn spawn_prompt(ctx: Ctx, sid: String, blocks: Vec<Value>) {
    ctx.shared.lock().in_flight += 1;
    tauri::async_runtime::spawn(async move {
        let res = ctx
            .conn
            .request("session/prompt", json!({ "sessionId": sid, "prompt": blocks }))
            .await;
        let (turn, redirects) = {
            let mut sh = ctx.shared.lock();
            let now = now_millis();
            sh.in_flight = sh.in_flight.saturating_sub(1);
            match res {
                Ok(v) => {
                    let stop = v.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn");
                    let ev = sh.view.turn_ended(stop, now);
                    sh.emit(ev);
                }
                Err(e) => {
                    if !sh.killed {
                        let message = if e.code == AUTH_REQUIRED {
                            auth_hint(&e)
                        } else {
                            format!("Prompt failed: {e}")
                        };
                        sh.emit(AcpEvent::Error { message });
                    }
                    let ev = sh.view.turn_ended("error", now);
                    sh.emit(ev);
                }
            }
            let redirects = if sh.in_flight == 0 {
                std::mem::take(&mut sh.redirects)
            } else {
                Vec::new()
            };
            (
                (
                    sh.view.first_prompt.clone(),
                    LastTurn {
                        ai_title: sh.view.title.clone(),
                        prompt: sh.view.task.clone(),
                        message: sh.view.last_message.clone(),
                    },
                ),
                redirects,
            )
        };
        for blocks in redirects {
            spawn_prompt(ctx.clone(), sid.clone(), blocks);
        }
        // Claude's adapter persists the conversation under the same id the
        // CLI uses, so it lands in history and resumes in a PTY tab.
        if matches!(ctx.backend, AgentBackendKind::ClaudeCode) {
            ctx.history.observe(
                &ctx.cwd,
                ctx.resumed_from.as_deref(),
                &sid,
                turn.0.as_deref(),
                &turn.1,
                now_millis(),
            );
        }
    });
}

fn handle<'a>(
    registry: &'a AgentRegistry,
    id: AgentSessionId,
) -> AppResult<dashmap::mapref::one::Ref<'a, AgentSessionId, AcpHandle>> {
    registry
        .acp
        .get(&id)
        .ok_or_else(|| AppError::Unknown(format!("unknown ACP agent: {id}")))
}

/// Swap in a fresh Channel: replay the event log as one batch, then the
/// status, then live events.
pub fn attach(
    registry: &AgentRegistry,
    id: AgentSessionId,
    channel: Channel<AgentEvent>,
) -> AppResult<AgentSession> {
    let h = handle(registry, id)?;
    let mut sh = h.shared.lock();
    let mut events = sh.log.clone();
    events.extend(sh.view.state_events());
    let _ = channel.send(AgentEvent::AcpBatch { events });
    let _ = channel.send(AgentEvent::Status {
        status: sh.status.clone(),
    });
    sh.channel = Some(channel);
    let mut s = h.session.clone();
    s.status = sh.status.clone();
    Ok(s)
}

/// How long an interrupting prompt waits for the cancelled turn to settle
/// before it's sent anyway.
const REDIRECT_TIMEOUT: Duration = Duration::from_secs(8);

/// Send a user prompt (`session/prompt`) with any attachments; queued if
/// the handshake is still running. Sent mid-turn it queues behind the
/// running turn in the agent — unless `interrupt`, which cancels the turn
/// and sends this once it has stopped.
pub fn send_prompt(
    registry: &AgentRegistry,
    id: AgentSessionId,
    text: &str,
    attachments: &[AcpAttachment],
    interrupt: bool,
) -> AppResult<()> {
    if text.trim().is_empty() && attachments.is_empty() {
        return Ok(());
    }
    let h = handle(registry, id)?;
    let mut sh = h.shared.lock();
    if !sh.live() {
        return Err(AppError::Unknown("This agent has exited.".into()));
    }
    let (blocks, labels) = prompt::build_prompt(text, attachments, &h.cwd, sh.view.caps)
        .map_err(AppError::Unknown)?;
    let ev = sh.view.prompt_started(text.trim(), labels, now_millis());
    sh.emit(ev);
    match sh.view.session_id.clone() {
        Some(_) if interrupt && sh.in_flight > 0 => {
            sh.redirects.push(blocks);
            drop(sh);
            cancel_turn(&h);
            // An agent that never answers the cancelled prompt mustn't
            // strand this one.
            let ctx = prompt_ctx(registry, &h, id);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(REDIRECT_TIMEOUT).await;
                let (late, sid) = {
                    let mut sh = ctx.shared.lock();
                    (std::mem::take(&mut sh.redirects), sh.view.session_id.clone())
                };
                if let Some(sid) = sid {
                    for blocks in late {
                        spawn_prompt(ctx.clone(), sid.clone(), blocks);
                    }
                }
            });
        }
        Some(sid) => {
            drop(sh);
            spawn_prompt(prompt_ctx(registry, &h, id), sid, blocks);
        }
        None => sh.queued.push(blocks),
    }
    Ok(())
}

fn prompt_ctx(registry: &AgentRegistry, h: &AcpHandle, id: AgentSessionId) -> Ctx {
    let sid = h.shared.lock().view.session_id.clone();
    Ctx {
        id,
        backend: h.session.backend,
        cwd: h.cwd.clone(),
        shared: h.shared.clone(),
        conn: h.conn.clone(),
        history: registry.history_handle(),
        pid: h.pid,
        cli: None,
        resumed_from: if h.session.resumed { sid } else { None },
    }
}

/// `session/cancel` the running turn. Any pending permission is answered
/// `cancelled`, as the spec requires.
pub fn cancel(registry: &AgentRegistry, id: AgentSessionId) -> AppResult<()> {
    cancel_turn(handle(registry, id)?.value());
    Ok(())
}

fn cancel_turn(h: &AcpHandle) {
    let mut sh = h.shared.lock();
    let Some(sid) = sh.view.session_id.clone() else {
        sh.queued.clear();
        return;
    };
    h.conn.notify("session/cancel", json!({ "sessionId": sid }));
    let now = now_millis();
    let cancelled = || RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
    if let Some(p) = sh.view.pending.as_ref().map(|p| p.request.id.clone()) {
        if let Some((rpc_id, ev)) = sh.view.resolve_permission(&p, None, now) {
            h.conn.respond(rpc_id, cancelled());
            sh.emit(ev);
        }
    }
    if let Some(q) = sh.view.question.as_ref().map(|(_, q)| q.id.clone()) {
        if let Some((rpc_id, ev)) = sh.view.resolve_question(&q, "cancel", None, now) {
            h.conn.respond(rpc_id, json!({ "action": "cancel" }));
            sh.emit(ev);
        }
    }
    // Queued requests were never shown; answer them without surfacing.
    for (rpc_id, _) in std::mem::take(&mut sh.waiting) {
        h.conn.respond(rpc_id, cancelled());
    }
}

/// Switch the session's permission mode (`session/set_mode`). The result
/// streams back as a `Modes` event (or an `Error`).
pub fn set_mode(registry: &AgentRegistry, id: AgentSessionId, mode_id: &str) -> AppResult<()> {
    let h = handle(registry, id)?;
    let (sid, conn, shared) = {
        let sh = h.shared.lock();
        let sid = sh
            .view
            .session_id
            .clone()
            .ok_or_else(|| AppError::Unknown("The agent is still starting.".into()))?;
        let offered = sh
            .view
            .modes
            .as_ref()
            .is_some_and(|m| m.available.iter().any(|x| x.id == mode_id));
        if !offered {
            return Err(AppError::Unknown(format!("This agent has no mode `{mode_id}`.")));
        }
        (sid, h.conn.clone(), h.shared.clone())
    };
    let mode_id = mode_id.to_string();
    tauri::async_runtime::spawn(async move {
        let res = conn
            .request("session/set_mode", json!({ "sessionId": sid, "modeId": mode_id }))
            .await;
        let mut sh = shared.lock();
        match res {
            Ok(_) => {
                if let Some(ev) = sh.view.mode_changed(&mode_id) {
                    sh.emit(ev);
                }
            }
            Err(e) => sh.emit(AcpEvent::Error {
                message: format!("Couldn't switch mode: {e}"),
            }),
        }
    });
    Ok(())
}

/// Change a session setting (`session/set_config_option`): model, effort,
/// mode, fast, … The agent answers with the full option set, which streams
/// back as a `Config` event.
pub fn set_config(
    registry: &AgentRegistry,
    id: AgentSessionId,
    config_id: &str,
    value: &str,
) -> AppResult<()> {
    let h = handle(registry, id)?;
    let (sid, conn, shared) = {
        let sh = h.shared.lock();
        let sid = sh
            .view
            .session_id
            .clone()
            .ok_or_else(|| AppError::Unknown("The agent is still starting.".into()))?;
        let valid = sh
            .view
            .all_config()
            .iter()
            .any(|o| o.id == config_id && o.options.iter().any(|x| x.value == value));
        if !valid {
            return Err(AppError::Unknown(format!(
                "This agent has no `{config_id}` setting `{value}`."
            )));
        }
        (sid, h.conn.clone(), h.shared.clone())
    };
    let config_id = config_id.to_string();
    let value = value.to_string();
    let legacy_model = config_id == view::LEGACY_MODEL_ID;
    tauri::async_runtime::spawn(async move {
        let res = if legacy_model {
            conn.request("session/set_model", json!({ "sessionId": sid, "modelId": value }))
                .await
        } else {
            conn.request(
                "session/set_config_option",
                json!({ "sessionId": sid, "configId": config_id, "value": value }),
            )
            .await
        };
        let mut sh = shared.lock();
        match res {
            Ok(_) if legacy_model => {
                if let Some(ev) = sh.view.legacy_model_changed(&value) {
                    sh.emit_state(ev);
                }
            }
            Ok(v) => {
                if let Some(ev) = v.get("configOptions").and_then(|c| sh.view.set_config(c)) {
                    sh.emit_state(ev);
                }
            }
            Err(e) => sh.emit(AcpEvent::Error {
                message: format!(
                    "Couldn't change {}: {e}",
                    if legacy_model { "model" } else { config_id.as_str() }
                ),
            }),
        }
    });
    Ok(())
}

/// Answer the pending question `request_id`: `accept` with `content` (the
/// form's values by field key), or `decline` / `cancel`.
pub fn answer_question(
    registry: &AgentRegistry,
    id: AgentSessionId,
    request_id: &str,
    action: &str,
    content: Option<Value>,
) -> AppResult<()> {
    if !matches!(action, "accept" | "decline" | "cancel") {
        return Err(AppError::Unknown(format!("unknown answer action `{action}`")));
    }
    let content = content.unwrap_or_else(|| json!({}));
    let summary = (action == "accept").then(|| answer_summary(&content)).flatten();
    let h = handle(registry, id)?;
    let mut sh = h.shared.lock();
    let Some((rpc_id, ev)) = sh.view.resolve_question(request_id, action, summary, now_millis())
    else {
        return Err(AppError::Unknown(
            "This agent is no longer waiting on that question.".into(),
        ));
    };
    let answer = match action {
        "accept" => json!({ "action": "accept", "content": content }),
        other => json!({ "action": other }),
    };
    h.conn.respond(rpc_id, answer);
    sh.emit(ev);
    Ok(())
}

/// The non-empty values of an accepted form, comma-joined: `Redis, macOS`.
fn answer_summary(content: &Value) -> Option<String> {
    let mut parts = Vec::new();
    for v in content.as_object()?.values() {
        match v {
            Value::String(s) if !s.trim().is_empty() => parts.push(s.trim().to_string()),
            Value::Array(a) => parts.extend(a.iter().filter_map(Value::as_str).map(str::to_string)),
            Value::Bool(b) => parts.push(if *b { "Yes" } else { "No" }.into()),
            Value::Number(n) => parts.push(n.to_string()),
            _ => {}
        }
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

/// Answer the pending permission request `request_id` with `option_id`.
pub fn respond_permission(
    registry: &AgentRegistry,
    id: AgentSessionId,
    request_id: &str,
    option_id: &str,
) -> AppResult<()> {
    let h = handle(registry, id)?;
    let mut sh = h.shared.lock();
    let Some((rpc_id, ev)) = sh
        .view
        .resolve_permission(request_id, Some(option_id), now_millis())
    else {
        return Err(AppError::Unknown(
            "This agent is no longer waiting on that permission request.".into(),
        ));
    };
    h.conn.respond(
        rpc_id,
        RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new(option_id.to_string()),
        )),
    );
    sh.emit(ev);
    sh.promote_waiting();
    Ok(())
}

/// The board's allow/deny: picks the matching once-option.
pub fn respond_permission_bool(
    registry: &AgentRegistry,
    id: AgentSessionId,
    allow: bool,
) -> AppResult<()> {
    let (request_id, option_id) = {
        let h = handle(registry, id)?;
        let sh = h.shared.lock();
        let p = sh.view.pending.as_ref().ok_or_else(|| {
            AppError::Unknown("This agent is no longer waiting on a permission request.".into())
        })?;
        let opt = sh.view.option_for(allow).ok_or_else(|| {
            AppError::Unknown("That permission request has no matching option.".into())
        })?;
        (p.request.id.clone(), opt)
    };
    respond_permission(registry, id, &request_id, &option_id)
}

#[cfg(test)]
mod tests {
    use super::view::AcpToolCall;
    use super::*;

    fn tool(id: &str, status: &str) -> AcpEvent {
        AcpEvent::Tool {
            tool: AcpToolCall {
                id: id.into(),
                title: "t".into(),
                kind: "execute".into(),
                status: status.into(),
                name: None,
                locations: vec![],
                content: vec![],
                raw_input: None,
            },
        }
    }

    #[test]
    fn log_coalesces_chunks_and_tool_updates() {
        let mut log = Vec::new();
        push_log(&mut log, AcpEvent::UserMessage { text: "hi".into(), attachments: vec![] });
        push_log(&mut log, AcpEvent::AgentText { text: "a".into() });
        push_log(&mut log, AcpEvent::AgentText { text: "b".into() });
        push_log(&mut log, tool("t1", "pending"));
        push_log(&mut log, AcpEvent::AgentText { text: "c".into() });
        push_log(&mut log, tool("t1", "completed"));
        push_log(&mut log, AcpEvent::Thought { text: "x".into() });
        push_log(&mut log, AcpEvent::Thought { text: "y".into() });
        push_log(&mut log, AcpEvent::UserText { text: "replayed ".into() });
        push_log(&mut log, AcpEvent::UserText { text: "prompt".into() });
        assert_eq!(
            log,
            vec![
                AcpEvent::UserMessage { text: "hi".into(), attachments: vec![] },
                AcpEvent::AgentText { text: "ab".into() },
                // Replaced in place: replay shows the final state where the
                // call first appeared.
                tool("t1", "completed"),
                AcpEvent::AgentText { text: "c".into() },
                AcpEvent::Thought { text: "xy".into() },
                AcpEvent::UserText { text: "replayed prompt".into() },
            ]
        );
    }

    /// Talks to a real adapter: `ACP_SMOKE_CMD="npx -y
    /// @agentclientprotocol/claude-agent-acp" cargo test acp_smoke --
    /// --ignored --nocapture`. Checks framing and the handshake; the prompt
    /// needs the agent to be signed in, and prints whatever comes back.
    #[tokio::test]
    #[ignore]
    async fn acp_smoke() {
        let cmd = std::env::var("ACP_SMOKE_CMD").expect("set ACP_SMOKE_CMD");
        let argv = crate::mcp::split_command(&cmd);
        let cwd = std::env::temp_dir();
        let mut child = tokio::process::Command::new(&argv[0])
            .args(&argv[1..])
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (conn, mut incoming) =
            RpcConn::start(child.stdout.take().unwrap(), child.stdin.take().unwrap());
        let init = conn
            .request(
                "initialize",
                json!({ "protocolVersion": 1, "clientCapabilities": { "fs": {}, "terminal": false } }),
            )
            .await
            .unwrap();
        println!("agent: {}", init["agentInfo"]);
        // ACP_SMOKE_LOAD=<id>: reopen a saved conversation instead, and
        // print its replay.
        let mut view = AcpView::new(0);
        let sid = if let Ok(id) = std::env::var("ACP_SMOKE_LOAD") {
            view.replaying = true;
            let c = conn.clone();
            let cwd2 = cwd.clone();
            let id2 = id.clone();
            let load = tokio::spawn(async move {
                c.request("session/load", json!({ "sessionId": id2, "cwd": cwd2, "mcpServers": [] }))
                    .await
            });
            loop {
                if load.is_finished() {
                    break;
                }
                if let Ok(Some(Incoming::Notification { method, mut params })) =
                    tokio::time::timeout(std::time::Duration::from_millis(200), incoming.recv()).await
                {
                    if method == "session/update" {
                        let raw = params.get_mut("update").map(Value::take).unwrap();
                        if let Ok(u) = serde_json::from_value::<SessionUpdate>(raw) {
                            if let Some(ev) = view.apply_update(u, 1) {
                                println!("replay: {ev:?}");
                            }
                        }
                    }
                }
            }
            println!("load result: {:?}", load.await.unwrap().map(|v| v.get("modes").is_some()));
            view.replay_finished(2);
            println!("last_message after replay: {:?}", view.last_message);
            id
        } else {
            let new = conn
                .request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))
                .await
                .unwrap();
            new["sessionId"].as_str().unwrap().to_string()
        };
        println!("session: {sid}");
        let c = conn.clone();
        let s2 = sid.clone();
        let prompt = tokio::spawn(async move {
            c.request(
                "session/prompt",
                json!({ "sessionId": s2, "prompt": [{ "type": "text", "text": "Reply with just: ok" }] }),
            )
            .await
        });
        view.prompt_started("Reply with just: ok", vec![], 0);
        let drain = async {
            while let Some(m) = incoming.recv().await {
                if let Incoming::Notification { method, mut params } = m {
                    if method == "session/update" {
                        let raw = params.get_mut("update").map(Value::take).unwrap();
                        match serde_json::from_value::<SessionUpdate>(raw.clone()) {
                            Ok(u) => {
                                if let Some(ev) = view.apply_update(u, 1) {
                                    println!("event: {ev:?}");
                                }
                            }
                            Err(_) => println!("unparsed update: {}", raw["sessionUpdate"]),
                        }
                    }
                }
            }
        };
        tokio::select! {
            r = prompt => println!("prompt result: {r:?}"),
            _ = drain => {},
            _ = tokio::time::sleep(std::time::Duration::from_secs(90)) => println!("timed out"),
        }
    }

    #[test]
    fn permission_responses_match_the_wire_format() {
        let selected = RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new("allow".to_string()),
        ));
        assert_eq!(
            serde_json::to_value(selected).unwrap(),
            json!({ "outcome": { "outcome": "selected", "optionId": "allow" } })
        );
        let cancelled = RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled);
        assert_eq!(
            serde_json::to_value(cancelled).unwrap(),
            json!({ "outcome": { "outcome": "cancelled" } })
        );
    }

    #[test]
    fn answer_summaries_join_values() {
        assert_eq!(
            answer_summary(&json!({ "question_0": "Redis", "question_0_custom": " ", "question_1": ["mac", "linux"] })),
            Some("Redis, mac, linux".into())
        );
        assert_eq!(answer_summary(&json!({ "ok": true, "n": 3 })), Some("Yes, 3".into()));
        assert_eq!(answer_summary(&json!({})), None);
    }

    /// An interrupting prompt cancels the running turn and goes out only
    /// after that turn has answered, so the cancel can't swallow it.
    #[tokio::test(flavor = "multi_thread")]
    async fn interrupt_waits_for_the_cancelled_turn() {
        use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader};

        let (client_out, agent_in) = duplex(1 << 16);
        let (mut agent_out, client_in) = duplex(1 << 16);
        let (conn, _incoming) = rpc::RpcConn::start(client_in, client_out);
        let mut lines = BufReader::new(agent_in).lines();
        async fn read(lines: &mut tokio::io::Lines<BufReader<tokio::io::DuplexStream>>) -> Value {
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap()
        }

        let registry = AgentRegistry::new();
        let id = AgentSessionId::new();
        let mut view = AcpView::new(0);
        view.session_id = Some("s".into());
        let shared = AcpShared {
            view,
            log: Vec::new(),
            channel: None,
            status: AgentStatus::Running,
            queued: Vec::new(),
            in_flight: 0,
            redirects: Vec::new(),
            waiting: VecDeque::new(),
            stderr_tail: VecDeque::new(),
            killed: false,
            exited_at: None,
        };
        registry.acp.insert(
            id,
            AcpHandle {
                session: AgentSession {
                    id,
                    worktree_id: WorktreeId::new(),
                    backend: AgentBackendKind::Codex,
                    argv: vec![],
                    started_at: 0,
                    cols: 0,
                    rows: 0,
                    status: AgentStatus::Running,
                    resumed: false,
                    transport: AgentTransport::Acp,
                },
                shared: Arc::new(Mutex::new(shared)),
                conn,
                pid: None,
                cwd: std::env::temp_dir(),
            },
        );

        send_prompt(&registry, id, "first", &[], false).unwrap();
        let first = read(&mut lines).await;
        assert_eq!(first["method"], "session/prompt");

        send_prompt(&registry, id, "second", &[], true).unwrap();
        let cancel = read(&mut lines).await;
        assert_eq!(cancel["method"], "session/cancel");

        // Nothing more until the first turn answers.
        let early = tokio::time::timeout(Duration::from_millis(150), read(&mut lines)).await;
        assert!(early.is_err(), "interrupting prompt sent before the turn settled");

        let reply = json!({ "jsonrpc": "2.0", "id": first["id"], "result": { "stopReason": "cancelled" } });
        agent_out.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
        let second = read(&mut lines).await;
        assert_eq!(second["method"], "session/prompt");
        assert_eq!(second["params"]["prompt"][0]["text"], "second");
    }

    #[test]
    fn log_is_bounded() {
        let mut log = Vec::new();
        for i in 0..LOG_MAX + 5 {
            push_log(&mut log, AcpEvent::Title { title: i.to_string() });
        }
        assert!(log.len() <= LOG_MAX);
        assert_eq!(log.last(), Some(&AcpEvent::Title { title: (LOG_MAX + 4).to_string() }));
    }
}
