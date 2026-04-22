//! Claude Code hook integration. We install a `.claude/settings.local.json`
//! per worktree that fires on Claude's lifecycle events and writes a one-
//! word status into a Treehouse-owned state file. A file watcher maps those
//! writes to `AgentActivity` updates, so the sidebar dot is driven by
//! authoritative signals from Claude rather than byte-timing heuristics.
//!
//! Event → state:
//!   UserPromptSubmit, PreToolUse, PostToolUse → `working`
//!   Stop                                      → `idle`
//!   Notification                              → `needs-attention`
//!
//! State file path: `<app_config_dir>/hook-state/<worktree_id>.state` (kept
//! outside the worktree so it never shows up in git status).

use std::any::Any;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use notify_debouncer_full::notify::{EventKind, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::util::errors::{AppError, AppResult};
use crate::util::ids::WorktreeId;

use super::AgentActivity;

const STATE_WORKING: &str = "working";
const STATE_IDLE: &str = "idle";
const STATE_NEEDS_ATTENTION: &str = "needs-attention";

/// Per-worktree hook-driven activity plus the `Instant` it was written.
/// The timestamp is used to auto-expire `NeedsAttention` — Claude doesn't
/// always fire `Stop` after a rejected permission prompt, so without a
/// timeout the red dot would stick forever once it fires.
pub type HookActivityMap = Arc<DashMap<WorktreeId, (AgentActivity, Instant)>>;

fn hook_state_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Unknown(format!("config dir: {e}")))?
        .join("hook-state"))
}

pub fn state_file_for(app: &AppHandle, worktree_id: WorktreeId) -> AppResult<PathBuf> {
    Ok(hook_state_dir(app)?.join(format!("{worktree_id}.state")))
}

fn parse_state(s: &str) -> Option<AgentActivity> {
    match s.trim() {
        STATE_WORKING => Some(AgentActivity::Working),
        STATE_IDLE => Some(AgentActivity::Idle),
        STATE_NEEDS_ATTENTION => Some(AgentActivity::NeedsAttention),
        _ => None,
    }
}

fn worktree_id_from_path(path: &Path) -> Option<WorktreeId> {
    let stem = path.file_stem()?.to_str()?;
    stem.parse::<WorktreeId>().ok()
}

/// Returns a hook-command `{"type":"command","command":"..."}` value that
/// writes `word` to our per-worktree state file. The command is idempotent
/// (plain `>` overwrite) and uses `printf %s` so no trailing newline ends
/// up in the file.
fn make_hook_command(state_path: &Path, word: &str) -> Value {
    let path_str = state_path.to_string_lossy().replace('"', "\\\"");
    json!({
        "type": "command",
        "command": format!("printf %s '{word}' > \"{path_str}\""),
    })
}

/// Install our hooks into `<worktree>/.claude/settings.local.json`. Any
/// existing entries the user has under our event names are replaced — this
/// is a local file that Claude Code treats as machine-managed, so we own
/// it. Returns the path to the state file so the watcher can seed it.
pub fn install(
    app: &AppHandle,
    worktree_path: &Path,
    worktree_id: WorktreeId,
) -> AppResult<()> {
    let state_path = state_file_for(app, worktree_id)?;
    if let Some(parent) = state_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Io(format!("create hook-state dir: {e}")))?;
    }

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

    let working = json!({
        "matcher": "",
        "hooks": [make_hook_command(&state_path, STATE_WORKING)],
    });
    let idle = json!({
        "matcher": "",
        "hooks": [make_hook_command(&state_path, STATE_IDLE)],
    });
    let needs = json!({
        "matcher": "",
        "hooks": [make_hook_command(&state_path, STATE_NEEDS_ATTENTION)],
    });

    let obj = settings.as_object_mut().unwrap();
    let hooks_val = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks_val.is_object() {
        *hooks_val = json!({});
    }
    let hooks = hooks_val.as_object_mut().unwrap();
    hooks.insert("UserPromptSubmit".into(), json!([working.clone()]));
    hooks.insert("PreToolUse".into(), json!([working.clone()]));
    hooks.insert("PostToolUse".into(), json!([working]));
    hooks.insert("Stop".into(), json!([idle]));
    hooks.insert("Notification".into(), json!([needs]));

    let out = serde_json::to_string_pretty(&settings)
        .map_err(|e| AppError::Unknown(format!("serialize settings: {e}")))?;
    std::fs::write(&settings_path, out)
        .map_err(|e| AppError::Io(format!("write settings.local.json: {e}")))?;

    // Seed the state file with `idle` so we have something to show before
    // the first hook fires.
    if !state_path.exists() {
        std::fs::write(&state_path, STATE_IDLE.as_bytes())
            .map_err(|e| AppError::Io(format!("init state file: {e}")))?;
    }

    Ok(())
}

/// Start a single watcher on the hook-state directory. Every file change
/// there corresponds to a `{worktree_id}.state` write from one of our
/// hooks; we parse the contents and push the resulting activity into the
/// shared map the activity query reads from.
pub fn start_watcher(
    app: &AppHandle,
    activity: HookActivityMap,
) -> AppResult<Box<dyn Any + Send + Sync>> {
    let dir = hook_state_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Io(format!("create hook-state dir: {e}")))?;

    let activity_cb = activity.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(50),
        None,
        move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            for ev in events {
                if !matches!(ev.event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    continue;
                }
                for path in &ev.event.paths {
                    let Some(worktree_id) = worktree_id_from_path(path) else {
                        continue;
                    };
                    let Ok(bytes) = std::fs::read(path) else { continue };
                    let Ok(text) = std::str::from_utf8(&bytes) else { continue };
                    if let Some(act) = parse_state(text) {
                        activity_cb.insert(worktree_id, (act, Instant::now()));
                    }
                }
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
