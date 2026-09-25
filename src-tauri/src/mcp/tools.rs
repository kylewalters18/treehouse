//! Tool definitions + dispatch. Tool failures are reported MCP-style — a
//! normal result with `isError: true` — so the calling agent can read the
//! reason and relay it, rather than seeing a protocol error.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent::supervisor;
use crate::ipc::commands::finish_create;
use crate::state::AppState;
use crate::util::ids::WorkspaceId;
use crate::storage;
use crate::worktree::{self, CreateOptions};

use super::{split_command, CallerScope, McpCaller};

/// PTY size for agents launched with nobody watching. The first attach
/// resizes to the real pane and the TUI redraws.
const HEADLESS_COLS: u16 = 120;
const HEADLESS_ROWS: u16 = 40;

pub fn list(scope: CallerScope) -> Value {
    match scope {
        CallerScope::Worktree(_) => json!([create_worktree_schema(scope)]),
        CallerScope::Scratch => json!([
            {
                "name": "list_repos",
                "description": "List the git repos currently open in treehouse — the only repos \
                    create_worktree can target. Call this first to get a valid `repo`; the set \
                    changes as the user opens and closes repos.",
                "inputSchema": { "type": "object", "properties": {} }
            },
            create_worktree_schema(scope),
        ]),
    }
}

fn create_worktree_schema(scope: CallerScope) -> Value {
    let scratch = scope == CallerScope::Scratch;
    let (what, base_hint) = if scratch {
        (
            "Create a new git worktree (and branch) in one of the repos open in treehouse \
            (see list_repos), shown in that repo's sidebar section like one the user created.",
            "Ref to branch from. Defaults to origin/<default branch>.",
        )
    } else {
        (
            "Create a new git worktree (and branch) as a sibling of the current one, \
            shown in treehouse's sidebar like one the user created.",
            "Ref to branch from. Defaults to origin/<default branch>. Pass the current branch \
            name to build on this worktree's committed work (uncommitted changes are not carried over).",
        )
    };
    let mut properties = json!({
        "name": {
            "type": "string",
            "description": "Short name; slugified into the branch and directory name (e.g. 'fix login redirect' → fix-login-redirect)."
        },
        "base": { "type": "string", "description": base_hint },
        "prompt": {
            "type": "string",
            "description": "First message for the new worktree's agent."
        }
    });
    let mut required = vec!["name"];
    if scratch {
        properties["repo"] = json!({
            "type": "string",
            "description": "Which open repo to create it in: a `name` or `path` from list_repos."
        });
        required.insert(0, "repo");
    }
    json!({
        "name": "create_worktree",
        "description": format!("{what} If `prompt` is given, a new agent is started in it with that \
            prompt as its first message; that agent starts with NO context from this conversation, \
            so make the prompt self-contained (goal, relevant files, constraints, how to verify). \
            The user is not switched to it. Always use this instead of `git worktree add` or \
            EnterWorktree — worktrees created those ways are invisible to treehouse."),
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
        }
    })
}

pub async fn call(app: &AppHandle, caller: McpCaller, params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
    let args = params.get("arguments").cloned().unwrap_or(Value::Null);
    let outcome = match name {
        "create_worktree" => create_worktree(app, caller, &args).await,
        "list_repos" if caller.scope == CallerScope::Scratch => Ok(list_repos(app)),
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
    let (workspace_id, created_by) = match caller.scope {
        CallerScope::Worktree(id) => {
            let parent = state
                .worktrees
                .get(&id)
                .map(|e| e.value().clone())
                .ok_or("the calling worktree no longer exists")?;
            (parent.workspace_id, parent.branch)
        }
        CallerScope::Scratch => {
            let repo = str_arg("repo").ok_or("`repo` is required — call list_repos for the options")?;
            let repos = open_repos(app);
            let i = resolve_repo(&repos, &repo)?;
            (repos[i].id, crate::scratch::CREATED_BY.to_string())
        }
    };
    let settings = storage::load_settings(app).await.unwrap_or_default();

    let result = worktree::create(
        Some(app),
        workspace_id,
        &name,
        CreateOptions {
            init_submodules: settings.init_submodules,
            base,
            created_by: Some(created_by.clone()),
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
    tracing::info!(id = %wt.id, parent = %created_by, "mcp: created worktree");

    // Prompt implies an agent; otherwise follow the user's "start default
    // agent" setting, same as the New Worktree dialog's default.
    let mut agent_error = None;
    let agent_started = if prompt.is_some() || settings.auto_start_agent {
        let backend = settings.default_agent_backend;
        let argv = split_command(settings.agent_commands.for_backend(backend));
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

/// An open workspace as the scratch agent sees it.
struct Repo {
    id: WorkspaceId,
    name: String,
    path: PathBuf,
    default_branch: String,
}

fn open_repos(app: &AppHandle) -> Vec<Repo> {
    let state = app.state::<AppState>();
    let mut repos: Vec<Repo> = state
        .workspaces
        .iter()
        .map(|e| {
            let ws = e.value();
            Repo {
                id: ws.id,
                name: ws
                    .root
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| ws.root.display().to_string()),
                path: ws.root.clone(),
                default_branch: ws.default_branch.clone(),
            }
        })
        .collect();
    repos.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
    repos
}

fn list_repos(app: &AppHandle) -> Value {
    let repos: Vec<Value> = open_repos(app)
        .into_iter()
        .map(|r| json!({ "name": r.name, "path": r.path, "defaultBranch": r.default_branch }))
        .collect();
    json!({ "repos": repos })
}

/// Match `query` against open repos by exact path, then by directory name.
/// Errors name the valid choices so the agent can retry without another
/// list_repos round-trip.
fn resolve_repo(repos: &[Repo], query: &str) -> Result<usize, String> {
    let q = query.trim_end_matches('/');
    if let Some(i) = repos.iter().position(|r| r.path == Path::new(q)) {
        return Ok(i);
    }
    let by_name: Vec<usize> = (0..repos.len()).filter(|&i| repos[i].name == q).collect();
    match by_name.as_slice() {
        [i] => Ok(*i),
        [] if repos.is_empty() => Err("no repos are open in treehouse".into()),
        [] => Err(format!(
            "no open repo named '{query}'. Open repos: {}",
            repos.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ")
        )),
        many => Err(format!(
            "more than one open repo is named '{query}'; pass its path instead: {}",
            many.iter().map(|&i| repos[i].path.display().to_string()).collect::<Vec<_>>().join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(name: &str, path: &str) -> Repo {
        Repo {
            id: WorkspaceId::new(),
            name: name.into(),
            path: path.into(),
            default_branch: "main".into(),
        }
    }

    #[test]
    fn resolve_repo_by_name_or_path() {
        let repos = vec![repo("api", "/code/api"), repo("web", "/code/web")];
        assert_eq!(resolve_repo(&repos, "web"), Ok(1));
        assert_eq!(resolve_repo(&repos, "/code/api/"), Ok(0));
        let err = resolve_repo(&repos, "nope").unwrap_err();
        assert!(err.contains("api, web"), "{err}");
    }

    #[test]
    fn resolve_repo_ambiguous_name_asks_for_path() {
        let repos = vec![repo("app", "/a/app"), repo("app", "/b/app")];
        let err = resolve_repo(&repos, "app").unwrap_err();
        assert!(err.contains("/a/app") && err.contains("/b/app"), "{err}");
        assert_eq!(resolve_repo(&repos, "/b/app"), Ok(1));
        assert!(resolve_repo(&[], "x").unwrap_err().contains("no repos"));
    }

    #[test]
    fn scratch_gets_list_repos_and_required_repo() {
        let tools = list(CallerScope::Scratch);
        let names: Vec<_> = tools.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["list_repos", "create_worktree"]);
        assert_eq!(tools[1]["inputSchema"]["required"], json!(["repo", "name"]));

        let tools = list(CallerScope::Worktree(crate::util::ids::WorktreeId::new()));
        assert_eq!(tools.as_array().unwrap().len(), 1);
        assert!(tools[0]["inputSchema"]["properties"].get("repo").is_none());
    }
}
