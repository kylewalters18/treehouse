//! Tool definitions + dispatch. Tool failures are reported MCP-style — a
//! normal result with `isError: true` — so the calling agent can read the
//! reason and relay it, rather than seeing a protocol error.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent::supervisor;
use crate::ipc::commands::finish_create;
use crate::state::AppState;
use crate::storage::{self, AgentCommands};
use crate::agent::AgentBackendKind;
use crate::worktree::{self, CreateOptions};

use super::{split_command, McpCaller};

/// PTY size for agents launched with nobody watching. The first attach
/// resizes to the real pane and the TUI redraws.
const HEADLESS_COLS: u16 = 120;
const HEADLESS_ROWS: u16 = 40;

pub fn list() -> Value {
    json!([{
        "name": "create_worktree",
        "description": "Create a new git worktree (and branch) as a sibling of the current one, \
            shown in treehouse's sidebar like one the user created. If `prompt` is given, a new \
            agent is started in it with that prompt as its first message; that agent starts with \
            NO context from this conversation, so make the prompt self-contained (goal, relevant \
            files, constraints, how to verify). The user is not switched to it. Always use this \
            instead of `git worktree add` or EnterWorktree — worktrees created those ways are \
            invisible to treehouse.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Short name; slugified into the branch and directory name (e.g. 'fix login redirect' → fix-login-redirect)."
                },
                "base": {
                    "type": "string",
                    "description": "Ref to branch from. Defaults to origin/<default branch>. Pass the current branch name to build on this worktree's committed work (uncommitted changes are not carried over)."
                },
                "prompt": {
                    "type": "string",
                    "description": "First message for the new worktree's agent."
                }
            },
            "required": ["name"]
        }
    }])
}

pub async fn call(app: &AppHandle, caller: McpCaller, params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
    let args = params.get("arguments").cloned().unwrap_or(Value::Null);
    let outcome = match name {
        "create_worktree" => create_worktree(app, caller, &args).await,
        other => Err(format!("unknown tool: {other}")),
    };
    match outcome {
        Ok(v) => json!({
            "content": [{ "type": "text", "text": v.to_string() }],
            "structuredContent": v,
        }),
        Err(msg) => json!({
            "content": [{ "type": "text", "text": msg }],
            "isError": true,
        }),
    }
}

async fn create_worktree(app: &AppHandle, caller: McpCaller, args: &Value) -> Result<Value, String> {
    let str_arg = |k: &str| {
        args.get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let name = str_arg("name").ok_or("`name` is required")?;
    let base = str_arg("base");
    let prompt = str_arg("prompt");

    let state = app.state::<AppState>();
    let parent = state
        .worktrees
        .get(&caller.worktree_id)
        .map(|e| e.value().clone())
        .ok_or("the calling worktree no longer exists")?;
    let workspace_id = parent.workspace_id;
    let settings = storage::load_settings(app).await.unwrap_or_default();

    let result = worktree::create(
        Some(app),
        workspace_id,
        &name,
        CreateOptions {
            init_submodules: settings.init_submodules,
            base,
            created_by: Some(parent.branch.clone()),
        },
        &state,
    )
    .await
    .map_err(|e| e.to_string())?;
    // Same post-create wiring as the sidebar button: watcher, status, and the
    // `worktrees-changed` fan-out that makes the row appear. No selection
    // change — that's the renderer's call and it deliberately doesn't.
    finish_create(app, workspace_id, &result);
    let wt = &result.worktree;
    tracing::info!(id = %wt.id, parent = %parent.branch, "mcp: created worktree");

    // Prompt implies an agent; otherwise follow the user's "start default
    // agent" setting, same as the New Worktree dialog's default.
    let mut agent_error = None;
    let agent_started = if prompt.is_some() || settings.auto_start_agent {
        let backend = settings.default_agent_backend;
        let argv = split_command(configured_command(&settings.agent_commands, backend));
        match supervisor::launch(
            app,
            &state.agents,
            wt.id,
            wt.path.clone(),
            backend,
            Some(argv),
            prompt.clone(),
            HEADLESS_COLS,
            HEADLESS_ROWS,
            None,
        ) {
            Ok(_) => true,
            Err(e) => {
                tracing::warn!(?e, id = %wt.id, "mcp: agent launch failed");
                agent_error = Some(e.to_string());
                false
            }
        }
    } else {
        false
    };
    let prompt_delivered = agent_started
        && prompt.is_some()
        && settings.default_agent_backend.accepts_positional_prompt();

    Ok(json!({
        "branch": wt.branch,
        "path": wt.path,
        "agentStarted": agent_started,
        "promptDelivered": prompt_delivered,
        "agentError": agent_error,
        "warning": result.warning,
    }))
}

fn configured_command(cmds: &AgentCommands, backend: AgentBackendKind) -> &str {
    match backend {
        AgentBackendKind::ClaudeCode => &cmds.claude_code,
        AgentBackendKind::Codex => &cmds.codex,
        AgentBackendKind::Kiro => &cmds.kiro,
    }
}
