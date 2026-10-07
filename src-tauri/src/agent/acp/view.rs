//! Pure state for one ACP session: folds ACP `session/update`s, permission
//! requests and turn boundaries into (a) transcript events for the pane and
//! (b) the same overview fields hook-driven PTY sessions report (activity,
//! task, current tool, last message, pending prompt). No I/O, no clocks —
//! callers pass `now_ms` — so the mapping is unit-testable.

use std::collections::HashMap;

use agent_client_protocol_schema::v1::{
    ContentBlock, PermissionOptionKind, RequestPermissionRequest, SessionModeState,
    SessionUpdate, ToolCall, ToolCallContent, ToolCallStatus, ToolCallUpdate, ToolKind,
};
use agent_client_protocol_schema::MaybeUndefined;
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use super::super::hooks::{first_line, truncate, MESSAGE_MAX, TASK_MAX, TOOL_MAX};
use super::super::{AgentActivity, PendingPrompt};

/// Cap on text carried in one tool-call content block. Tool output (a long
/// `cargo test`, a file read) can be huge; the pane only needs a preview.
const TOOL_TEXT_MAX: usize = 8_000;
/// Cap on a tool call's pretty-printed raw input.
const RAW_INPUT_MAX: usize = 4_000;

/// One structured transcript event, streamed inside `AgentEvent::Acp` and
/// replayed on attach. The pane reduces these into its transcript.
#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum AcpEvent {
    /// Handshake finished; prompts can flow. `sessionId` is the agent's own
    /// id — for Claude, the conversation `claude --resume` takes.
    Ready {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "agentName")]
        agent_name: Option<String>,
        /// The treehouse MCP server was offered to the session.
        #[serde(rename = "mcpAttached")]
        mcp_attached: bool,
        /// The Claude CLI the adapter was pointed at (`CLAUDE_CODE_EXECUTABLE`);
        /// `None` = the adapter's own bundled CLI, or not a Claude session.
        cli: Option<String>,
    },
    /// A prompt treehouse sent (typed in the pane, or a review batch).
    UserMessage { text: String },
    /// A chunk of the agent's reply; consecutive chunks form one message.
    AgentText { text: String },
    /// A chunk of the agent's visible reasoning.
    Thought { text: String },
    /// A tool call was created or changed. Always the full current state;
    /// the pane upserts by `tool.id`.
    Tool { tool: AcpToolCall },
    /// The agent's plan, replaced wholesale on every update.
    Plan { entries: Vec<AcpPlanEntry> },
    Permission { request: AcpPermissionRequest },
    /// `optionId` is `None` when the request was cancelled.
    PermissionResolved {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "optionId")]
        option_id: Option<String>,
    },
    TurnEnded {
        #[serde(rename = "stopReason")]
        stop_reason: String,
    },
    Title { title: String },
    /// The session's permission modes and which is current. Sent after
    /// `session/new` and whenever the mode changes.
    Modes { modes: AcpModes },
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AcpModes {
    pub current: String,
    pub available: Vec<AcpMode>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AcpMode {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AcpToolCall {
    pub id: String,
    pub title: String,
    /// ACP tool kind: `read`, `edit`, `execute`, `search`, `fetch`, …
    pub kind: String,
    /// `pending`, `in_progress`, `completed`, or `failed`.
    pub status: String,
    /// The agent's internal tool name (`Bash`, `Edit`), when it sends one.
    pub name: Option<String>,
    pub locations: Vec<String>,
    pub content: Vec<AcpToolContent>,
    /// The tool's input as pretty JSON (truncated) — shown when `content`
    /// doesn't say what the call does.
    pub raw_input: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum AcpToolContent {
    Text {
        text: String,
    },
    Diff {
        path: String,
        #[serde(rename = "oldText")]
        old_text: Option<String>,
        #[serde(rename = "newText")]
        new_text: String,
    },
    /// An agent-side terminal. We don't offer `terminal/*`, so this only
    /// appears if the agent embeds its own.
    Terminal {
        #[serde(rename = "terminalId")]
        terminal_id: String,
    },
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AcpPlanEntry {
    pub content: String,
    /// `pending`, `in_progress`, `completed`.
    pub status: String,
    pub priority: String,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AcpPermissionRequest {
    /// The JSON-RPC request id, stringified — what the respond command names.
    pub id: String,
    pub tool_call_id: String,
    pub title: String,
    pub options: Vec<AcpPermissionOption>,
    /// The gated tool call as of the request (diff, command, plan).
    pub tool: AcpToolCall,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AcpPermissionOption {
    pub id: String,
    pub name: String,
    /// `allow_once`, `allow_always`, `reject_once`, `reject_always`.
    pub kind: String,
}

/// A permission request the agent is blocked on, with the raw JSON-RPC id
/// needed to answer it.
#[derive(Debug, Clone)]
pub struct PendingPermission {
    pub rpc_id: Value,
    pub request: AcpPermissionRequest,
    pub tool_name: String,
    pub detail: Option<String>,
}

#[derive(Debug, Default)]
pub struct AcpView {
    /// The agent's session id once `session/new` returned.
    pub session_id: Option<String>,
    /// `session/prompt` calls in flight. Claude's adapter queues prompts,
    /// so a second prompt mid-turn is legal.
    pub turns: u32,
    pub activity: Option<AgentActivity>,
    pub changed_at: u64,
    pub title: Option<String>,
    pub task: Option<String>,
    pub first_prompt: Option<String>,
    pub current_tool: Option<String>,
    pub last_message: Option<String>,
    pub pending: Option<PendingPermission>,
    /// The agent's reply so far in the current turn.
    reply: String,
    tools: HashMap<String, AcpToolCall>,
    pub modes: Option<AcpModes>,
}

impl AcpView {
    pub fn new(now_ms: u64) -> Self {
        Self {
            activity: Some(AgentActivity::Idle),
            changed_at: now_ms,
            ..Self::default()
        }
    }

    pub fn activity(&self) -> AgentActivity {
        self.activity.unwrap_or(AgentActivity::Idle)
    }

    fn set_activity(&mut self, a: AgentActivity, now_ms: u64) {
        if self.activity != Some(a) {
            self.activity = Some(a);
            self.changed_at = now_ms;
        }
    }

    /// The board's `pending` field: only while blocked on a permission.
    pub fn pending_prompt(&self) -> Option<PendingPrompt> {
        self.pending.as_ref().map(|p| PendingPrompt::Permission {
            tool_name: p.tool_name.clone(),
            detail: p.detail.clone(),
        })
    }

    /// A prompt is about to be sent (or queued until the session is up).
    pub fn prompt_started(&mut self, text: &str, now_ms: u64) -> AcpEvent {
        self.turns += 1;
        self.task = first_line(text, TASK_MAX);
        if self.first_prompt.is_none() {
            self.first_prompt = self.task.clone();
        }
        self.current_tool = None;
        self.last_message = None;
        self.reply.clear();
        if self.pending.is_none() {
            self.set_activity(AgentActivity::Working, now_ms);
        }
        AcpEvent::UserMessage {
            text: text.to_string(),
        }
    }

    /// Fold one `session/update`. Returns the transcript event to stream, if
    /// the update is one the pane shows.
    pub fn apply_update(&mut self, update: SessionUpdate, now_ms: u64) -> Option<AcpEvent> {
        match update {
            SessionUpdate::AgentMessageChunk(c) => {
                let text = block_text(&c.content)?;
                self.reply.push_str(&text);
                Some(AcpEvent::AgentText { text })
            }
            SessionUpdate::AgentThoughtChunk(c) => {
                block_text(&c.content).map(|text| AcpEvent::Thought { text })
            }
            SessionUpdate::ToolCall(tc) => {
                let tool = from_tool_call(tc);
                self.track_tool(&tool, now_ms);
                Some(AcpEvent::Tool { tool })
            }
            SessionUpdate::ToolCallUpdate(u) => {
                let tool = self.merge_tool_update(u);
                self.track_tool(&tool, now_ms);
                Some(AcpEvent::Tool { tool })
            }
            SessionUpdate::Plan(p) => Some(AcpEvent::Plan {
                entries: p
                    .entries
                    .into_iter()
                    .map(|e| AcpPlanEntry {
                        content: e.content,
                        status: enum_str(&e.status),
                        priority: enum_str(&e.priority),
                    })
                    .collect(),
            }),
            SessionUpdate::CurrentModeUpdate(u) => {
                let modes = self.modes.as_mut()?;
                modes.current = u.current_mode_id.0.to_string();
                Some(AcpEvent::Modes {
                    modes: modes.clone(),
                })
            }
            SessionUpdate::SessionInfoUpdate(info) => match info.title {
                MaybeUndefined::Value(t) => {
                    let t = first_line(&t, TASK_MAX)?;
                    self.title = Some(t.clone());
                    Some(AcpEvent::Title { title: t })
                }
                MaybeUndefined::Null => {
                    self.title = None;
                    None
                }
                MaybeUndefined::Undefined => None,
            },
            // Our own prompts are already in the transcript (UserMessage);
            // modes, commands, usage and the rest aren't shown.
            _ => None,
        }
    }

    fn track_tool(&mut self, tool: &AcpToolCall, now_ms: u64) {
        self.tools.insert(tool.id.clone(), tool.clone());
        if matches!(tool.status.as_str(), "pending" | "in_progress") {
            self.current_tool = Some(tool_label(tool));
        }
        if self.turns > 0 && self.pending.is_none() {
            self.set_activity(AgentActivity::Working, now_ms);
        }
    }

    fn merge_tool_update(&mut self, u: ToolCallUpdate) -> AcpToolCall {
        let id = u.tool_call_id.0.to_string();
        let mut t = self.tools.get(&id).cloned().unwrap_or_else(|| AcpToolCall {
            id: id.clone(),
            title: String::new(),
            kind: "other".into(),
            status: "pending".into(),
            name: None,
            locations: vec![],
            content: vec![],
            raw_input: None,
        });
        let f = u.fields;
        if let Some(title) = f.title {
            t.title = title;
        }
        if let Some(kind) = f.kind {
            t.kind = kind_str(kind);
        }
        if let Some(status) = f.status {
            t.status = status_str(status);
        }
        if let Some(name) = f.name.or_else(|| meta_tool_name(u.meta.as_ref())) {
            t.name = Some(name);
        }
        if let Some(locs) = f.locations {
            t.locations = locs.into_iter().map(|l| l.path.display().to_string()).collect();
        }
        if let Some(content) = f.content {
            t.content = content.into_iter().filter_map(tool_content).collect();
        }
        if let Some(raw) = f.raw_input {
            t.raw_input = raw_input(&raw);
        }
        t
    }

    /// Modes from `session/new`. Returns the event to stream.
    pub fn set_modes(&mut self, state: SessionModeState) -> Option<AcpEvent> {
        if state.available_modes.is_empty() {
            return None;
        }
        let modes = AcpModes {
            current: state.current_mode_id.0.to_string(),
            available: state
                .available_modes
                .into_iter()
                .map(|m| AcpMode {
                    id: m.id.0.to_string(),
                    name: m.name,
                    description: m.description,
                })
                .collect(),
        };
        self.modes = Some(modes.clone());
        Some(AcpEvent::Modes { modes })
    }

    /// The agent accepted `session/set_mode`. `None` if `id` isn't offered.
    pub fn mode_changed(&mut self, id: &str) -> Option<AcpEvent> {
        let modes = self.modes.as_mut()?;
        if !modes.available.iter().any(|m| m.id == id) {
            return None;
        }
        modes.current = id.to_string();
        Some(AcpEvent::Modes {
            modes: modes.clone(),
        })
    }

    /// The agent asked for permission. Becomes the board's pending prompt.
    pub fn permission_requested(
        &mut self,
        rpc_id: Value,
        req: RequestPermissionRequest,
        now_ms: u64,
    ) -> AcpEvent {
        let tool_call_id = req.tool_call.tool_call_id.0.to_string();
        // The request carries a (possibly partial) tool-call update; fold it
        // in so the title/name reflect the tool being gated.
        let tool = self.merge_tool_update(req.tool_call);
        self.tools.insert(tool_call_id.clone(), tool.clone());
        let title = if tool.title.is_empty() {
            "Permission requested".to_string()
        } else {
            tool.title.clone()
        };
        let request = AcpPermissionRequest {
            id: id_string(&rpc_id),
            tool_call_id,
            title: title.clone(),
            options: req
                .options
                .into_iter()
                .map(|o| AcpPermissionOption {
                    id: o.option_id.0.to_string(),
                    name: o.name,
                    kind: enum_str(&o.kind),
                })
                .collect(),
            tool: tool.clone(),
        };
        self.pending = Some(PendingPermission {
            rpc_id,
            request: request.clone(),
            tool_name: tool.name.clone().unwrap_or_else(|| tool.kind.clone()),
            detail: first_line(&title, TOOL_MAX),
        });
        self.set_activity(AgentActivity::NeedsAttention, now_ms);
        AcpEvent::Permission { request }
    }

    /// The option the board's allow/deny maps to: the first `allow_once`
    /// (else any allow) or `reject_once` (else any reject).
    pub fn option_for(&self, allow: bool) -> Option<String> {
        let p = self.pending.as_ref()?;
        let (once, any) = if allow {
            (PermissionOptionKind::AllowOnce, "allow_")
        } else {
            (PermissionOptionKind::RejectOnce, "reject_")
        };
        let once = enum_str(&once);
        let opts = &p.request.options;
        opts.iter()
            .find(|o| o.kind == once)
            .or_else(|| opts.iter().find(|o| o.kind.starts_with(any)))
            .map(|o| o.id.clone())
    }

    /// Answer (or cancel, with `None`) the pending permission. Returns the
    /// JSON-RPC id to respond to plus the transcript event, or `None` when
    /// `request_id` isn't what's pending.
    pub fn resolve_permission(
        &mut self,
        request_id: &str,
        option_id: Option<&str>,
        now_ms: u64,
    ) -> Option<(Value, AcpEvent)> {
        let p = self.pending.as_ref()?;
        if p.request.id != request_id {
            return None;
        }
        if let Some(o) = option_id {
            if !p.request.options.iter().any(|x| x.id == o) {
                return None;
            }
        }
        let p = self.pending.take()?;
        let a = if self.turns > 0 {
            AgentActivity::Working
        } else {
            AgentActivity::Idle
        };
        self.set_activity(a, now_ms);
        Some((
            p.rpc_id,
            AcpEvent::PermissionResolved {
                request_id: p.request.id,
                option_id: option_id.map(str::to_string),
            },
        ))
    }

    /// A `session/prompt` call returned (or failed, `stop_reason = "error"`).
    pub fn turn_ended(&mut self, stop_reason: &str, now_ms: u64) -> AcpEvent {
        self.turns = self.turns.saturating_sub(1);
        if self.turns == 0 {
            self.current_tool = None;
            self.pending = None;
            let reply = self.reply.trim();
            if !reply.is_empty() {
                self.last_message = Some(truncate(reply, MESSAGE_MAX));
            }
            self.set_activity(AgentActivity::Idle, now_ms);
        }
        AcpEvent::TurnEnded {
            stop_reason: stop_reason.to_string(),
        }
    }
}

/// `Bash: cargo test`-style label, matching the hook-driven summary.
fn tool_label(t: &AcpToolCall) -> String {
    let title = first_line(&t.title, TOOL_MAX).unwrap_or_default();
    match &t.name {
        Some(n) if !title.is_empty() && !title.starts_with(n.as_str()) => format!("{n}: {title}"),
        Some(n) if title.is_empty() => n.clone(),
        _ if title.is_empty() => t.kind.clone(),
        _ => title,
    }
}

fn from_tool_call(tc: ToolCall) -> AcpToolCall {
    AcpToolCall {
        id: tc.tool_call_id.0.to_string(),
        title: tc.title,
        kind: kind_str(tc.kind),
        status: status_str(tc.status),
        name: tc.name.or_else(|| meta_tool_name(tc.meta.as_ref())),
        locations: tc
            .locations
            .into_iter()
            .map(|l| l.path.display().to_string())
            .collect(),
        content: tc.content.into_iter().filter_map(tool_content).collect(),
        raw_input: tc.raw_input.as_ref().and_then(raw_input),
    }
}

fn raw_input(v: &Value) -> Option<String> {
    if v.is_null() || v.as_object().is_some_and(|o| o.is_empty()) {
        return None;
    }
    serde_json::to_string_pretty(v)
        .ok()
        .map(|s| truncate(&s, RAW_INPUT_MAX))
}

/// Claude's adapter puts the SDK tool name under `_meta.claudeCode.toolName`.
fn meta_tool_name(meta: Option<&serde_json::Map<String, Value>>) -> Option<String> {
    meta?
        .get("claudeCode")?
        .get("toolName")?
        .as_str()
        .map(str::to_string)
}

fn tool_content(c: ToolCallContent) -> Option<AcpToolContent> {
    match c {
        ToolCallContent::Content(c) => block_text(&c.content).map(|t| AcpToolContent::Text {
            text: truncate(&t, TOOL_TEXT_MAX),
        }),
        ToolCallContent::Diff(d) => Some(AcpToolContent::Diff {
            path: d.path.display().to_string(),
            old_text: d.old_text.map(|t| truncate(&t, TOOL_TEXT_MAX)),
            new_text: truncate(&d.new_text, TOOL_TEXT_MAX),
        }),
        ToolCallContent::Terminal(t) => Some(AcpToolContent::Terminal {
            terminal_id: t.terminal_id.0.to_string(),
        }),
        _ => None,
    }
}

fn block_text(b: &ContentBlock) -> Option<String> {
    match b {
        ContentBlock::Text(t) => Some(t.text.clone()),
        ContentBlock::ResourceLink(l) => Some(format!("[{}]({})", l.name, l.uri)),
        _ => None,
    }
}

fn kind_str(k: ToolKind) -> String {
    enum_str(&k)
}

fn status_str(s: ToolCallStatus) -> String {
    enum_str(&s)
}

/// The wire spelling of a unit enum (`"in_progress"`), via its serde impl.
fn enum_str<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "other".into())
}

pub fn id_string(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn update(v: Value) -> SessionUpdate {
        serde_json::from_value(v).expect("valid session update")
    }

    fn permission(v: Value) -> RequestPermissionRequest {
        serde_json::from_value(v).expect("valid permission request")
    }

    fn bash_permission() -> RequestPermissionRequest {
        permission(json!({
            "sessionId": "s1",
            "toolCall": { "toolCallId": "t1", "title": "`rm -rf build`", "kind": "execute" },
            "options": [
                { "optionId": "always", "name": "Always allow", "kind": "allow_always" },
                { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                { "optionId": "reject", "name": "Reject", "kind": "reject_once" },
            ],
        }))
    }

    #[test]
    fn a_turn_maps_to_overview_fields() {
        let mut v = AcpView::new(0);
        assert_eq!(v.activity(), AgentActivity::Idle);

        let ev = v.prompt_started("Fix the build\nmore detail", 1);
        assert_eq!(ev, AcpEvent::UserMessage { text: "Fix the build\nmore detail".into() });
        assert_eq!(v.activity(), AgentActivity::Working);
        assert_eq!(v.changed_at, 1);
        assert_eq!(v.task.as_deref(), Some("Fix the build"));
        assert_eq!(v.first_prompt.as_deref(), Some("Fix the build"));

        let ev = v.apply_update(
            update(json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "t1",
                "title": "`cargo test`",
                "kind": "execute",
                "status": "pending",
                "_meta": { "claudeCode": { "toolName": "Bash" } },
            })),
            2,
        );
        let Some(AcpEvent::Tool { tool }) = ev else { panic!("{ev:?}") };
        assert_eq!(tool.name.as_deref(), Some("Bash"));
        assert_eq!(tool.kind, "execute");
        assert_eq!(v.current_tool.as_deref(), Some("Bash: `cargo test`"));

        // Updates merge into the known call.
        let ev = v.apply_update(
            update(json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "completed",
                "content": [{ "type": "content", "content": { "type": "text", "text": "ok" } }],
            })),
            3,
        );
        let Some(AcpEvent::Tool { tool }) = ev else { panic!("{ev:?}") };
        assert_eq!(tool.title, "`cargo test`");
        assert_eq!(tool.status, "completed");
        assert_eq!(tool.content, vec![AcpToolContent::Text { text: "ok".into() }]);

        for chunk in ["All ", "tests pass."] {
            let ev = v.apply_update(
                update(json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": chunk },
                })),
                4,
            );
            assert_eq!(ev, Some(AcpEvent::AgentText { text: chunk.into() }));
        }

        let ev = v.turn_ended("end_turn", 5);
        assert_eq!(ev, AcpEvent::TurnEnded { stop_reason: "end_turn".into() });
        assert_eq!(v.activity(), AgentActivity::Idle);
        assert_eq!(v.changed_at, 5);
        assert_eq!(v.current_tool, None);
        assert_eq!(v.last_message.as_deref(), Some("All tests pass."));

        // The next prompt clears the previous reply, like UserPromptSubmit.
        v.prompt_started("again", 6);
        assert_eq!(v.last_message, None);
        assert_eq!(v.first_prompt.as_deref(), Some("Fix the build"));
    }

    #[test]
    fn titles_plans_and_unknown_updates() {
        let mut v = AcpView::new(0);
        let ev = v.apply_update(
            update(json!({ "sessionUpdate": "session_info_update", "title": "Fix CI\n" })),
            1,
        );
        assert_eq!(ev, Some(AcpEvent::Title { title: "Fix CI".into() }));
        assert_eq!(v.title.as_deref(), Some("Fix CI"));

        let ev = v.apply_update(
            update(json!({
                "sessionUpdate": "plan",
                "entries": [
                    { "content": "Read code", "priority": "high", "status": "completed" },
                    { "content": "Write fix", "priority": "medium", "status": "in_progress" },
                ],
            })),
            2,
        );
        let Some(AcpEvent::Plan { entries }) = ev else { panic!("{ev:?}") };
        assert_eq!(entries[1].status, "in_progress");
        assert_eq!(entries[0].priority, "high");

        let ev = v.apply_update(
            update(json!({
                "sessionUpdate": "available_commands_update",
                "availableCommands": [],
            })),
            3,
        );
        assert_eq!(ev, None);
    }

    #[test]
    fn permission_request_blocks_until_answered() {
        let mut v = AcpView::new(0);
        v.prompt_started("clean up", 1);
        let ev = v.permission_requested(json!(7), bash_permission(), 2);
        let AcpEvent::Permission { request } = ev else { panic!() };
        assert_eq!(request.id, "7");
        assert_eq!(request.options.len(), 3);
        assert_eq!(request.tool.title, "`rm -rf build`");
        assert_eq!(request.tool.kind, "execute");
        assert_eq!(v.activity(), AgentActivity::NeedsAttention);
        assert_eq!(
            v.pending_prompt(),
            Some(PendingPrompt::Permission {
                tool_name: "execute".into(),
                detail: Some("`rm -rf build`".into()),
            })
        );

        // Tool chatter while blocked doesn't hide the prompt.
        v.apply_update(
            update(json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1" })),
            3,
        );
        assert_eq!(v.activity(), AgentActivity::NeedsAttention);

        // Board buttons pick the once-options.
        assert_eq!(v.option_for(true).as_deref(), Some("allow"));
        assert_eq!(v.option_for(false).as_deref(), Some("reject"));

        // Wrong request id or unknown option: refused, still pending.
        assert!(v.resolve_permission("8", Some("allow"), 4).is_none());
        assert!(v.resolve_permission("7", Some("bogus"), 4).is_none());
        assert!(v.pending.is_some());

        let (rpc_id, ev) = v.resolve_permission("7", Some("allow"), 5).unwrap();
        assert_eq!(rpc_id, json!(7));
        assert_eq!(
            ev,
            AcpEvent::PermissionResolved {
                request_id: "7".into(),
                option_id: Some("allow".into()),
            }
        );
        assert_eq!(v.activity(), AgentActivity::Working);
        assert_eq!(v.pending_prompt(), None);
        // Answered once; a stale second click is refused.
        assert!(v.resolve_permission("7", Some("allow"), 6).is_none());
    }

    #[test]
    fn permission_carries_the_gated_tool_content() {
        let mut v = AcpView::new(0);
        v.apply_update(
            update(json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "e1",
                "title": "Edit src/lib.rs",
                "kind": "edit",
                "content": [{ "type": "diff", "path": "/r/src/lib.rs", "oldText": "a", "newText": "b" }],
                "rawInput": { "file_path": "/r/src/lib.rs" },
            })),
            1,
        );
        let ev = v.permission_requested(
            json!(1),
            permission(json!({
                "sessionId": "s",
                "toolCall": { "toolCallId": "e1" },
                "options": [{ "optionId": "ok", "name": "Yes", "kind": "allow_once" }],
            })),
            2,
        );
        let AcpEvent::Permission { request } = ev else { panic!() };
        assert_eq!(request.title, "Edit src/lib.rs");
        assert_eq!(
            request.tool.content,
            vec![AcpToolContent::Diff {
                path: "/r/src/lib.rs".into(),
                old_text: Some("a".into()),
                new_text: "b".into(),
            }]
        );
        assert!(request.tool.raw_input.as_deref().unwrap().contains("file_path"));
    }

    #[test]
    fn modes_track_session_new_and_updates() {
        let mut v = AcpView::new(0);
        let state: SessionModeState = serde_json::from_value(json!({
            "currentModeId": "default",
            "availableModes": [
                { "id": "default", "name": "Manual" },
                { "id": "plan", "name": "Plan", "description": "Plan first" },
            ],
        }))
        .unwrap();
        let Some(AcpEvent::Modes { modes }) = v.set_modes(state) else { panic!() };
        assert_eq!(modes.current, "default");
        assert_eq!(modes.available[1].description.as_deref(), Some("Plan first"));

        let ev = v.apply_update(
            update(json!({ "sessionUpdate": "current_mode_update", "currentModeId": "plan" })),
            1,
        );
        assert!(matches!(ev, Some(AcpEvent::Modes { modes }) if modes.current == "plan"));
        assert!(v.mode_changed("bogus").is_none());
        assert!(matches!(v.mode_changed("default"), Some(AcpEvent::Modes { modes }) if modes.current == "default"));
    }

    #[test]
    fn cancelling_a_permission_outside_a_turn_goes_idle() {
        let mut v = AcpView::new(0);
        v.permission_requested(json!("p"), bash_permission(), 1);
        let (_, ev) = v.resolve_permission("p", None, 2).unwrap();
        assert_eq!(
            ev,
            AcpEvent::PermissionResolved { request_id: "p".into(), option_id: None }
        );
        assert_eq!(v.activity(), AgentActivity::Idle);
    }

    #[test]
    fn option_for_falls_back_to_any_allow_or_reject() {
        let mut v = AcpView::new(0);
        v.permission_requested(
            json!(1),
            permission(json!({
                "sessionId": "s",
                "toolCall": { "toolCallId": "t" },
                "options": [
                    { "optionId": "a", "name": "Always", "kind": "allow_always" },
                    { "optionId": "r", "name": "Never", "kind": "reject_always" },
                ],
            })),
            1,
        );
        assert_eq!(v.option_for(true).as_deref(), Some("a"));
        assert_eq!(v.option_for(false).as_deref(), Some("r"));
        // No title on the gated call: a generic one.
        let p = v.pending.as_ref().unwrap();
        assert_eq!(p.request.title, "Permission requested");
    }

    #[test]
    fn queued_prompts_keep_working_until_the_last_turn_ends() {
        let mut v = AcpView::new(0);
        v.prompt_started("one", 1);
        v.prompt_started("two", 2);
        v.turn_ended("end_turn", 3);
        assert_eq!(v.activity(), AgentActivity::Working);
        v.turn_ended("cancelled", 4);
        assert_eq!(v.activity(), AgentActivity::Idle);
        // Extra ends never underflow.
        v.turn_ended("end_turn", 5);
        assert_eq!(v.turns, 0);
    }
}
