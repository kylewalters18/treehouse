//! Claude Code hook integration. We install a `.claude/settings.local.json`
//! per worktree whose hooks copy each lifecycle event's JSON payload into a
//! Treehouse-owned directory. A file watcher parses those files into a
//! per-session `HookSession`, so the sidebar dot and the agent board are
//! driven by authoritative signals from Claude rather than byte timing.
//!
//! Hooks are shared by every Claude process in the worktree, so each one
//! tells sessions apart by `$TREEHOUSE_AGENT_SESSION`, which the supervisor
//! sets when it spawns an agent. A `claude` the user runs by hand in a
//! terminal tab doesn't have it, and its events are dropped.
//!
//! Event → activity:
//!   UserPromptSubmit, PreToolUse, PostToolUse → `Working`
//!   Stop                                      → `Idle`
//!   PermissionRequest                         → `NeedsAttention`
//!   Notification                              → `NeedsAttention`, except
//!                                               `idle_prompt` (the turn
//!                                               already ended at `Stop`)
//!
//! Files: `<app_config_dir>/hook-state/session-<id>.<Event>.json`, one per
//! event name so a burst (PreToolUse then PermissionRequest) can't coalesce
//! into one read. Kept outside the worktree so they never show in git status.

use std::any::Any;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use notify_debouncer_full::notify::{EventKind, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::util::errors::{AppError, AppResult};
use crate::util::ids::AgentSessionId;

use super::{AgentActivity, PendingPrompt};

/// Env var the supervisor sets on every agent it spawns. Hook commands
/// read it to name their state files.
pub const SESSION_ENV: &str = "TREEHOUSE_AGENT_SESSION";

const FILE_PREFIX: &str = "session-";

/// Events we hook, and whether the hook keeps the payload. PostToolUse's
/// payload carries the whole tool response (file contents, command output)
/// and we only need the fact that it fired.
const HOOKED_EVENTS: &[(&str, bool)] = &[
    ("UserPromptSubmit", true),
    ("PreToolUse", true),
    ("PostToolUse", false),
    ("PermissionRequest", true),
    ("Notification", true),
    ("Stop", true),
];

/// Caps on strings copied out of payloads. The board clamps visually;
/// these just stop a pasted log or a huge heredoc from riding every poll.
const TASK_MAX: usize = 200;
const TOOL_MAX: usize = 300;
const MESSAGE_MAX: usize = 2000;

/// Hook-derived state for one agent session.
#[derive(Debug, Clone)]
pub struct HookSession {
    pub activity: AgentActivity,
    /// Epoch ms when `activity` last changed.
    pub changed_at: u64,
    /// When `activity` last changed. Used to expire `NeedsAttention`.
    pub set_at: Instant,
    pub task: Option<String>,
    pub current_tool: Option<String>,
    pub last_message: Option<String>,
    pub pending: Option<PendingPrompt>,
}

impl HookSession {
    fn new(now_ms: u64, now: Instant) -> Self {
        Self {
            activity: AgentActivity::Idle,
            changed_at: now_ms,
            set_at: now,
            task: None,
            current_tool: None,
            last_message: None,
            pending: None,
        }
    }

    fn set_activity(&mut self, act: AgentActivity, now_ms: u64, now: Instant) {
        if self.activity != act {
            self.activity = act;
            self.changed_at = now_ms;
            self.set_at = now;
        }
    }
}

pub type HookSessionMap = Arc<DashMap<AgentSessionId, HookSession>>;

/// Fold one hook event into a session's state. Pure apart from its
/// arguments so the transitions are unit-testable.
pub fn apply_event(
    s: &mut HookSession,
    event: &str,
    payload: &Value,
    now_ms: u64,
    now: Instant,
) {
    match event {
        "UserPromptSubmit" => {
            s.set_activity(AgentActivity::Working, now_ms, now);
            s.pending = None;
            s.current_tool = None;
            s.last_message = None;
            if let Some(p) = payload.get("prompt").and_then(Value::as_str) {
                s.task = first_line(p, TASK_MAX);
            }
        }
        "PreToolUse" => {
            s.set_activity(AgentActivity::Working, now_ms, now);
            s.pending = None;
            if let Some((name, detail)) = tool_call(payload) {
                s.current_tool = Some(match detail {
                    Some(d) => format!("{name}: {}", first_line(&d, TOOL_MAX).unwrap_or(d)),
                    None => name,
                });
            }
        }
        "PostToolUse" => {
            s.set_activity(AgentActivity::Working, now_ms, now);
            s.pending = None;
        }
        "PermissionRequest" => {
            s.set_activity(AgentActivity::NeedsAttention, now_ms, now);
            let (tool_name, detail) =
                tool_call(payload).unwrap_or_else(|| ("tool".to_string(), None));
            s.pending = Some(PendingPrompt::Permission { tool_name, detail });
        }
        "Notification" => {
            let kind = payload.get("notification_type").and_then(Value::as_str);
            match kind {
                // Fires ~60s after `Stop`; the turn already ended, and
                // treating it as a new alert would flip every finished
                // agent to amber a minute later.
                Some("idle_prompt") | Some("auth_success") => {}
                _ => {
                    s.set_activity(AgentActivity::NeedsAttention, now_ms, now);
                    if s.pending.is_none() {
                        let message = payload
                            .get("message")
                            .and_then(Value::as_str)
                            .and_then(|m| first_line(m, TOOL_MAX));
                        s.pending = Some(PendingPrompt::Input { message });
                    }
                }
            }
        }
        "Stop" => {
            s.set_activity(AgentActivity::Idle, now_ms, now);
            s.pending = None;
            s.current_tool = None;
            if let Some(m) = payload.get("last_assistant_message").and_then(Value::as_str) {
                let m = m.trim();
                if !m.is_empty() {
                    s.last_message = Some(truncate(m, MESSAGE_MAX));
                }
            }
        }
        _ => {}
    }
}

/// `(tool_name, detail)` from a PreToolUse / PermissionRequest payload.
/// `detail` is the single most identifying input: the command for Bash,
/// the path for file tools (relative to the session's cwd), and so on.
fn tool_call(payload: &Value) -> Option<(String, Option<String>)> {
    let name = payload.get("tool_name").and_then(Value::as_str)?.to_string();
    let input = payload.get("tool_input");
    let field = |k: &str| input.and_then(|i| i.get(k)).and_then(Value::as_str);
    let detail = match name.as_str() {
        "Bash" => field("command").map(str::to_string),
        "Read" | "Write" | "Edit" | "MultiEdit" => field("file_path").map(|p| {
            let cwd = payload.get("cwd").and_then(Value::as_str).unwrap_or("");
            relative_to(p, cwd)
        }),
        "NotebookEdit" => field("notebook_path").map(|p| {
            let cwd = payload.get("cwd").and_then(Value::as_str).unwrap_or("");
            relative_to(p, cwd)
        }),
        "Grep" | "Glob" => field("pattern").map(str::to_string),
        "WebFetch" => field("url").map(str::to_string),
        "WebSearch" => field("query").map(str::to_string),
        "Task" | "Agent" => field("description").map(str::to_string),
        _ => None,
    };
    Some((name, detail.map(|d| truncate(d.trim(), MESSAGE_MAX))))
}

fn relative_to(path: &str, cwd: &str) -> String {
    if cwd.is_empty() {
        return path.to_string();
    }
    Path::new(path)
        .strip_prefix(cwd)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

fn first_line(s: &str, max: usize) -> Option<String> {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| truncate(l, max))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

fn hook_state_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Unknown(format!("config dir: {e}")))?
        .join("hook-state"))
}

/// `session-<id>.<Event>.json` → `(id, Event)`.
fn parse_file_name(path: &Path) -> Option<(AgentSessionId, String)> {
    if path.extension()? != "json" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    let rest = stem.strip_prefix(FILE_PREFIX)?;
    let (id, event) = rest.split_once('.')?;
    Some((id.parse().ok()?, event.to_string()))
}

/// Shell command for one event: copy the payload (or nothing) into
/// `session-$TREEHOUSE_AGENT_SESSION.<event>.json` via tmp + rename, so
/// the watcher never reads a half-written file. Always drains stdin so
/// Claude never sees a broken pipe.
fn make_hook_command(dir: &Path, event: &str, keep_payload: bool) -> Value {
    let dir = dir.to_string_lossy().replace('"', "\\\"");
    let body = if keep_payload {
        "cat > \"$f.tmp\""
    } else {
        "cat > /dev/null; : > \"$f.tmp\""
    };
    json!({
        "type": "command",
        "command": format!(
            "[ -n \"${SESSION_ENV}\" ] || {{ cat > /dev/null; exit 0; }}; \
             f=\"{dir}/{FILE_PREFIX}${SESSION_ENV}.{event}\"; \
             {body} && mv -f \"$f.tmp\" \"$f.json\""
        ),
    })
}

/// Install our hooks into `<worktree>/.claude/settings.local.json`. Any
/// existing entries the user has under our event names are replaced — this
/// is a local file that Claude Code treats as machine-managed, so we own it.
pub fn install(app: &AppHandle, worktree_path: &Path) -> AppResult<()> {
    install_into(&hook_state_dir(app)?, worktree_path)
}

fn install_into(state_dir: &Path, worktree_path: &Path) -> AppResult<()> {
    std::fs::create_dir_all(state_dir)
        .map_err(|e| AppError::Io(format!("create hook-state dir: {e}")))?;

    let claude_dir = worktree_path.join(".claude");
    std::fs::create_dir_all(&claude_dir)
        .map_err(|e| AppError::Io(format!("create .claude dir: {e}")))?;
    let settings_path = claude_dir.join("settings.local.json");

    let mut settings: Value = match std::fs::read(&settings_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(AppError::Io(format!("read settings.local.json: {e}"))),
    };
    if !settings.is_object() {
        settings = json!({});
    }

    let obj = settings.as_object_mut().unwrap();
    let hooks_val = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks_val.is_object() {
        *hooks_val = json!({});
    }
    let hooks = hooks_val.as_object_mut().unwrap();
    for (event, keep) in HOOKED_EVENTS {
        hooks.insert(
            (*event).into(),
            json!([{ "matcher": "", "hooks": [make_hook_command(state_dir, event, *keep)] }]),
        );
    }

    let out = serde_json::to_string_pretty(&settings)
        .map_err(|e| AppError::Unknown(format!("serialize settings: {e}")))?;
    std::fs::write(&settings_path, out)
        .map_err(|e| AppError::Io(format!("write settings.local.json: {e}")))?;
    Ok(())
}

/// Delete a finished session's state files. Best-effort.
pub fn remove_session_files(app: &AppHandle, id: AgentSessionId) {
    let Ok(dir) = hook_state_dir(app) else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let prefix = format!("{FILE_PREFIX}{id}.");
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Start a single watcher on the hook-state directory and fold every
/// session file write into `sessions`. Files left over from a previous run
/// belong to sessions that no longer exist, so the directory is cleared
/// first (this also drops the pre-session `<worktree_id>.state` files).
pub fn start_watcher(
    app: &AppHandle,
    sessions: HookSessionMap,
) -> AppResult<Box<dyn Any + Send + Sync>> {
    let dir = hook_state_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Io(format!("create hook-state dir: {e}")))?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }

    let mut debouncer = new_debouncer(
        Duration::from_millis(50),
        None,
        move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let mut changed: Vec<PathBuf> = Vec::new();
            for ev in events {
                if matches!(ev.event.kind, EventKind::Remove(_)) {
                    continue;
                }
                for p in &ev.event.paths {
                    if parse_file_name(p).is_some() && !changed.contains(p) {
                        changed.push(p.clone());
                    }
                }
            }
            // Several events can land in one debounce window. Apply them in
            // the order the hooks wrote them — mtime survives the rename.
            let mut stamped: Vec<(SystemTime, PathBuf)> = changed
                .into_iter()
                .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
                .collect();
            stamped.sort_by_key(|(t, _)| *t);
            for (_, path) in stamped {
                let Some((id, event)) = parse_file_name(&path) else { continue };
                let Ok(bytes) = std::fs::read(&path) else { continue };
                let payload: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                let (now_ms, now) = (now_millis(), Instant::now());
                let mut entry = sessions
                    .entry(id)
                    .or_insert_with(|| HookSession::new(now_ms, now));
                apply_event(&mut entry, &event, &payload, now_ms, now);
            }
        },
    )
    .map_err(|e| AppError::Unknown(format!("hook watcher: {e}")))?;

    debouncer
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| AppError::Unknown(format!("hook watch: {e}")))?;

    Ok(Box::new(debouncer))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> HookSession {
        HookSession::new(0, Instant::now())
    }

    fn apply(s: &mut HookSession, event: &str, payload: Value, at: u64) {
        apply_event(s, event, &payload, at, Instant::now());
    }

    #[test]
    fn turn_lifecycle() {
        let mut s = fresh();
        apply(&mut s, "UserPromptSubmit", json!({ "prompt": "\n  Fix the flaky test\nmore" }), 10);
        assert_eq!(s.activity, AgentActivity::Working);
        assert_eq!(s.task.as_deref(), Some("Fix the flaky test"));
        assert_eq!(s.changed_at, 10);

        apply(
            &mut s,
            "PreToolUse",
            json!({ "tool_name": "Edit", "cwd": "/w", "tool_input": { "file_path": "/w/src/a.rs" } }),
            20,
        );
        assert_eq!(s.current_tool.as_deref(), Some("Edit: src/a.rs"));
        // Still working: the state's start time doesn't move per tool.
        assert_eq!(s.changed_at, 10);

        apply(&mut s, "Stop", json!({ "last_assistant_message": "  Done. Tests pass.  " }), 30);
        assert_eq!(s.activity, AgentActivity::Idle);
        assert_eq!(s.last_message.as_deref(), Some("Done. Tests pass."));
        assert_eq!(s.current_tool, None);
        assert_eq!(s.changed_at, 30);

        // The next turn drops the previous turn's reply.
        apply(&mut s, "UserPromptSubmit", json!({ "prompt": "Now the docs" }), 40);
        assert_eq!(s.last_message, None);
        assert_eq!(s.task.as_deref(), Some("Now the docs"));
    }

    #[test]
    fn permission_request_then_resolution() {
        let mut s = fresh();
        apply(
            &mut s,
            "PermissionRequest",
            json!({ "tool_name": "Bash", "tool_input": { "command": "cargo test\n--quiet" } }),
            5,
        );
        assert_eq!(s.activity, AgentActivity::NeedsAttention);
        assert_eq!(
            s.pending,
            Some(PendingPrompt::Permission {
                tool_name: "Bash".into(),
                detail: Some("cargo test\n--quiet".into()),
            })
        );
        // The matching Notification must not overwrite the richer prompt.
        apply(
            &mut s,
            "Notification",
            json!({ "notification_type": "permission_prompt", "message": "Claude needs your permission to use Bash" }),
            6,
        );
        assert!(matches!(s.pending, Some(PendingPrompt::Permission { .. })));
        assert_eq!(s.changed_at, 5);

        apply(&mut s, "PostToolUse", Value::Null, 9);
        assert_eq!(s.activity, AgentActivity::Working);
        assert_eq!(s.pending, None);
    }

    #[test]
    fn idle_prompt_notification_is_ignored() {
        let mut s = fresh();
        apply(&mut s, "Stop", json!({}), 1);
        apply(
            &mut s,
            "Notification",
            json!({ "notification_type": "idle_prompt", "message": "Claude is waiting for your input" }),
            61,
        );
        assert_eq!(s.activity, AgentActivity::Idle);
        assert_eq!(s.pending, None);
    }

    #[test]
    fn other_notification_asks_for_input() {
        let mut s = fresh();
        apply(&mut s, "Notification", json!({ "message": "Pick an option" }), 1);
        assert_eq!(s.activity, AgentActivity::NeedsAttention);
        assert_eq!(
            s.pending,
            Some(PendingPrompt::Input { message: Some("Pick an option".into()) })
        );
    }

    #[test]
    fn parses_session_file_names() {
        let id = AgentSessionId::new();
        let p = PathBuf::from(format!("/x/session-{id}.PreToolUse.json"));
        assert_eq!(parse_file_name(&p), Some((id, "PreToolUse".into())));
        assert_eq!(parse_file_name(&PathBuf::from(format!("/x/session-{id}.Stop.tmp"))), None);
        assert_eq!(parse_file_name(&PathBuf::from("/x/session-none.Stop.json")), None);
        assert_eq!(parse_file_name(&PathBuf::from(format!("/x/{id}.state"))), None);
    }

    #[test]
    fn install_hooks_every_event_and_keeps_other_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let wt = tmp.path().join("wt");
        let state = tmp.path().join("state dir");
        std::fs::create_dir_all(wt.join(".claude")).unwrap();
        std::fs::write(
            wt.join(".claude/settings.local.json"),
            r#"{ "permissions": { "allow": ["Bash(ls)"] } }"#,
        )
        .unwrap();

        install_into(&state, &wt).unwrap();
        let v: Value =
            serde_json::from_slice(&std::fs::read(wt.join(".claude/settings.local.json")).unwrap())
                .unwrap();
        assert_eq!(v["permissions"]["allow"][0], "Bash(ls)");
        for (event, _) in HOOKED_EVENTS {
            let cmd = v["hooks"][event][0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.contains(&format!("${SESSION_ENV}.{event}\"")), "{event}: {cmd}");
        }
    }

    #[test]
    fn hook_command_writes_payload_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("hook state");
        std::fs::create_dir_all(&dir).unwrap();
        let id = AgentSessionId::new();
        let run = |event: &str, keep: bool, env: Option<String>| {
            let cmd = make_hook_command(&dir, event, keep);
            let mut c = std::process::Command::new("sh");
            c.arg("-c").arg(cmd["command"].as_str().unwrap());
            c.env_remove(SESSION_ENV);
            if let Some(v) = env {
                c.env(SESSION_ENV, v);
            }
            c.stdin(std::process::Stdio::piped());
            let mut child = c.spawn().unwrap();
            use std::io::Write as _;
            child.stdin.take().unwrap().write_all(br#"{"a":1}"#).unwrap();
            assert!(child.wait().unwrap().success());
        };

        run("Stop", true, Some(id.to_string()));
        let written = std::fs::read_to_string(dir.join(format!("session-{id}.Stop.json"))).unwrap();
        assert_eq!(written, r#"{"a":1}"#);

        run("PostToolUse", false, Some(id.to_string()));
        let written =
            std::fs::read_to_string(dir.join(format!("session-{id}.PostToolUse.json"))).unwrap();
        assert_eq!(written, "");

        // Outside a treehouse agent: nothing written.
        let before = std::fs::read_dir(&dir).unwrap().count();
        run("Stop", true, None);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), before);
    }
}
