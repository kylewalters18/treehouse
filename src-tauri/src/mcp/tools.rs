//! Tool definitions + dispatch. Tool failures are reported MCP-style — a
//! normal result with `isError: true` — so the calling agent can read the
//! reason and relay it, rather than seeing a protocol error.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent::supervisor;
use crate::forge::{workflow, IssueStart};
use crate::ipc::commands::{finish_create, resolve_forge};
use crate::state::AppState;
use crate::storage;
use crate::util::ids::WorkspaceId;
use crate::worktree::{self, CreateOptions};

use super::{split_command, CallerScope, McpCaller};

/// PTY size for agents launched with nobody watching. The first attach
/// resizes to the real pane and the TUI redraws.
const HEADLESS_COLS: u16 = 120;
const HEADLESS_ROWS: u16 = 40;

pub fn list(scope: CallerScope) -> Value {
    match scope {
        CallerScope::Worktree(_) => json!([
            create_issue_schema(scope),
            create_worktree_schema(scope),
            create_pr_schema(),
        ]),
        // A planner has a repo but no worktree, so nothing to open a PR from.
        CallerScope::Planner(_) => {
            json!([create_issue_schema(scope), create_worktree_schema(scope),])
        }
        CallerScope::Scratch => json!([
            {
                "name": "list_repos",
                "description": "List the git repos currently open in treehouse — the only repos \
                    create_worktree and create_issue can target. Call this first to get a valid \
                    `repo`; the set changes as the user opens and closes repos.",
                "inputSchema": { "type": "object", "properties": {} }
            },
            create_issue_schema(scope),
            create_worktree_schema(scope),
        ]),
    }
}

fn repo_property() -> Value {
    json!({
        "type": "string",
        "description": "Which open repo: a `name` or `path` from list_repos."
    })
}

fn create_issue_schema(scope: CallerScope) -> Value {
    let mut properties = json!({
        "title": { "type": "string", "description": "Issue title." },
        "body": {
            "type": "string",
            "description": "Issue description. Write it to stand on its own for whoever picks it up: \
                the problem, where it shows up, and what done looks like."
        }
    });
    let mut required = vec!["title", "body"];
    if scope == CallerScope::Scratch {
        properties["repo"] = repo_property();
        required.insert(0, "repo");
    }
    json!({
        "name": "create_issue",
        "description": "File a new issue on this repo's GitLab/GitHub project (it is visible to the \
            team). Returns its number and URL; pass the number to create_worktree's `issue` to start \
            work on it.",
        "inputSchema": { "type": "object", "properties": properties, "required": required }
    })
}

fn create_pr_schema() -> Value {
    json!({
        "name": "create_pr",
        "description": "Push THIS worktree's branch and open a pull/merge request for it against the \
            branch it was created from. Commit your work first — treehouse never commits for you, and \
            this refuses when the branch has no commits ahead of its base. When this worktree is \
            linked to an issue, the description gets a `Closes #n` line (unless close_issue is false).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "PR/MR title." },
                "body": {
                    "type": "string",
                    "description": "Description for reviewers: what changed, why, and how it was verified."
                },
                "draft": { "type": "boolean", "description": "Open as a draft. Default false." },
                "close_issue": {
                    "type": "boolean",
                    "description": "Close the linked issue when this merges. Default true."
                }
            },
            "required": ["title", "body"]
        }
    })
}

fn create_worktree_schema(scope: CallerScope) -> Value {
    let scratch = scope == CallerScope::Scratch;
    let (what, base_hint) = match scope {
        CallerScope::Scratch => (
            "Create a new git worktree (and branch) in one of the repos open in treehouse \
            (see list_repos), shown in that repo's sidebar section like one the user created.",
            "Ref to branch from. Defaults to origin/<default branch>.",
        ),
        CallerScope::Planner(_) => (
            "Create a new git worktree (and branch) in this repo, shown in its sidebar section \
            like one the user created.",
            "Ref to branch from. Defaults to origin/<default branch>.",
        ),
        CallerScope::Worktree(_) => (
            "Create a new git worktree (and branch) as a sibling of the current one, \
            shown in treehouse's sidebar like one the user created.",
            "Ref to branch from. Defaults to origin/<default branch>. Pass the current branch \
            name to build on this worktree's committed work (uncommitted changes are not carried over).",
        ),
    };
    let mut properties = json!({
        "name": {
            "type": "string",
            "description": "Short name; slugified into the branch and directory name (e.g. 'fix login redirect' → fix-login-redirect)."
        },
        "base": { "type": "string", "description": base_hint },
        "prompt": {
            "type": "string",
            "description": "First message for the new worktree's agent. With `issue`, this is added \
                after the issue text — use it for extra instructions."
        },
        "issue": {
            "type": "integer",
            "description": "Work on this existing issue number: links the worktree to it (its PR will \
                close it) and seeds the new agent with the issue. `name` defaults to `<n>-<title>`."
        }
    });
    let mut required = vec![];
    if scratch {
        properties["repo"] = repo_property();
        required.push("repo");
    }
    json!({
        "name": "create_worktree",
        "description": format!("{what} Pass `name`, `issue`, or both. If `prompt` or `issue` is \
            given, a new agent is started in it with that as its first message; that agent starts \
            with NO context from this conversation, so make the prompt self-contained (goal, \
            relevant files, constraints, how to verify). If the user wants a pull/merge request \
            for the work, say so in `prompt`: tell the new agent to commit when done and call \
            create_pr — you can't open it for them. The user is not switched to it. Always use \
            this instead of `git worktree add` or EnterWorktree — worktrees created those ways are \
            invisible to treehouse."),
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
        }
    })
}

pub async fn call(app: &AppHandle, caller: McpCaller, params: &Value) -> Value {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let args = params.get("arguments").cloned().unwrap_or(Value::Null);
    let outcome = match name {
        "create_worktree" => create_worktree(app, caller, &args).await,
        "create_issue" => create_issue(app, caller, &args).await,
        "create_pr" => create_pr(app, caller, &args).await,
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

fn str_arg(args: &Value, k: &str) -> Option<String> {
    args.get(k)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The workspace a call targets, and a label naming the caller for logs: the
/// caller's own repo for a worktree agent, the `repo` argument for the
/// scratch agent.
fn target_workspace(
    app: &AppHandle,
    caller: McpCaller,
    args: &Value,
) -> Result<(WorkspaceId, String), String> {
    let state = app.state::<AppState>();
    match caller.scope {
        CallerScope::Worktree(id) => {
            let parent = state
                .worktrees
                .get(&id)
                .map(|e| e.value().clone())
                .ok_or("the calling worktree no longer exists")?;
            Ok((parent.workspace_id, parent.branch))
        }
        CallerScope::Planner(ws) => Ok((ws, "planner".to_string())),
        CallerScope::Scratch => {
            let repo = str_arg(args, "repo")
                .ok_or("`repo` is required — call list_repos for the options")?;
            let repos = open_repos(app);
            let i = resolve_repo(&repos, &repo)?;
            Ok((repos[i].id, "scratch".to_string()))
        }
    }
}

async fn create_issue(app: &AppHandle, caller: McpCaller, args: &Value) -> Result<Value, String> {
    let title = str_arg(args, "title").ok_or("`title` is required")?;
    let body = str_arg(args, "body").unwrap_or_default();
    let (workspace_id, _) = target_workspace(app, caller, args)?;
    let state = app.state::<AppState>();
    let (forge, _) = resolve_forge(workspace_id, &state)
        .await
        .map_err(|e| e.to_string())?;
    let issue = forge
        .create_issue(&title, &body)
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!(number = issue.number, "mcp: created issue");
    Ok(json!({ "number": issue.number, "url": issue.url, "title": issue.title }))
}

async fn create_worktree(
    app: &AppHandle,
    caller: McpCaller,
    args: &Value,
) -> Result<Value, String> {
    let base = str_arg(args, "base");
    let extra_prompt = str_arg(args, "prompt");
    let issue_number = match args.get("issue") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_u64().ok_or("`issue` must be an issue number")?),
    };
    let (workspace_id, caller_label) = target_workspace(app, caller, args)?;
    let state = app.state::<AppState>();

    // With an issue, read it up front: a bad number fails before anything is
    // created, and it names the branch when `name` is omitted.
    let issue = match issue_number {
        Some(n) => {
            let (forge, _) = resolve_forge(workspace_id, &state)
                .await
                .map_err(|e| e.to_string())?;
            let issue = forge
                .get_issue(n)
                .await
                .map_err(|e| format!("couldn't read #{n}: {e}"))?;
            Some((forge, issue))
        }
        None => None,
    };
    let name = match (str_arg(args, "name"), &issue) {
        (Some(n), _) => n,
        // Matches the dialog: `<n>-` + the title, slug kept short.
        (None, Some((_, i))) => {
            format!(
                "{}-{}",
                i.number,
                i.title.chars().take(50).collect::<String>()
            )
        }
        (None, None) => return Err("pass `name`, `issue`, or both".into()),
    };
    let settings = storage::load_settings(app).await.unwrap_or_default();

    let mut result = worktree::create(
        Some(app),
        workspace_id,
        &name,
        CreateOptions {
            init_submodules: settings.init_submodules,
            base,
        },
        &state,
    )
    .await
    .map_err(|e| e.to_string())?;
    // Same post-create wiring as the sidebar button: watcher, status, and the
    // `worktrees-changed` fan-out that makes the row appear. No selection
    // change — that's the renderer's call and it deliberately doesn't.
    finish_create(app, workspace_id, &result);
    tracing::info!(id = %result.worktree.id, caller = %caller_label, "mcp: created worktree");

    // Link (never assign — that's the user's call) and seed from the issue;
    // an explicit prompt rides after the issue text.
    let mut warnings: Vec<String> = result.warning.take().into_iter().collect();
    let mut prompt = extra_prompt.clone();
    if let Some((forge, i)) = &issue {
        let start = IssueStart {
            number: i.number,
            assign: false,
            link: true,
        };
        let started = workflow::start_from_issue(app, forge, &result.worktree.path, &start).await;
        warnings.extend(started.warnings);
        let seed = started.prompt.unwrap_or_else(|| workflow::issue_prompt(i));
        prompt = Some(match extra_prompt {
            Some(p) => format!("{seed}\n{p}"),
            None => seed,
        });
    }
    let wt = &result.worktree;

    // A prompt implies an agent; otherwise follow the user's "start default
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
            None,
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
    let prompt_delivered = agent_started && prompt.is_some();

    Ok(json!({
        "branch": wt.branch,
        "path": wt.path,
        "issue": issue_number,
        "agentStarted": agent_started,
        "promptDelivered": prompt_delivered,
        "agentError": agent_error,
        "warning": (!warnings.is_empty()).then(|| warnings.join("; ")),
    }))
}

/// Open a PR/MR for the calling agent's own worktree.
async fn create_pr(app: &AppHandle, caller: McpCaller, args: &Value) -> Result<Value, String> {
    let CallerScope::Worktree(id) = caller.scope else {
        return Err(
            "create_pr opens a PR for the calling worktree; this agent has none — \
            tell a worktree's agent to call it"
                .into(),
        );
    };
    let title = str_arg(args, "title").ok_or("`title` is required")?;
    let body = str_arg(args, "body").unwrap_or_default();
    let draft = args.get("draft").and_then(Value::as_bool).unwrap_or(false);
    let close_issue = args
        .get("close_issue")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let state = app.state::<AppState>();
    let wt = state
        .worktrees
        .get(&id)
        .map(|e| e.value().clone())
        .ok_or("the calling worktree no longer exists")?;
    if wt.is_main_clone {
        return Err("create_pr can't open a PR from the main clone".into());
    }
    let (forge, root) = resolve_forge(wt.workspace_id, &state)
        .await
        .map_err(|e| e.to_string())?;
    let mr = workflow::create_pr(
        app,
        &state,
        &forge,
        &root,
        wt.workspace_id,
        &wt.branch,
        &title,
        &body,
        draft,
        close_issue,
    )
    .await
    .map_err(|e| e.to_string())?;
    tracing::info!(number = mr.number, branch = %wt.branch, "mcp: created PR");
    Ok(json!({ "number": mr.number, "url": mr.url, "draft": mr.draft }))
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
            repos
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
        many => Err(format!(
            "more than one open repo is named '{query}'; pass its path instead: {}",
            many.iter()
                .map(|&i| repos[i].path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
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

    fn names(tools: &Value) -> Vec<&str> {
        tools
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn scratch_gets_list_repos_and_required_repo_but_no_create_pr() {
        let tools = list(CallerScope::Scratch);
        assert_eq!(
            names(&tools),
            ["list_repos", "create_issue", "create_worktree"]
        );
        assert_eq!(
            tools[1]["inputSchema"]["required"],
            json!(["repo", "title", "body"])
        );
        assert_eq!(tools[2]["inputSchema"]["required"], json!(["repo"]));
    }

    #[test]
    fn planners_act_on_their_repo_without_create_pr() {
        let tools = list(CallerScope::Planner(WorkspaceId::new()));
        assert_eq!(names(&tools), ["create_issue", "create_worktree"]);
        for t in tools.as_array().unwrap() {
            assert!(
                t["inputSchema"]["properties"].get("repo").is_none(),
                "{}",
                t["name"]
            );
        }
        let desc = tools[1]["description"].as_str().unwrap();
        assert!(desc.contains("in this repo"), "{desc}");
    }

    #[test]
    fn worktree_agents_get_create_pr_and_no_repo_arg() {
        let tools = list(CallerScope::Worktree(crate::util::ids::WorktreeId::new()));
        assert_eq!(
            names(&tools),
            ["create_issue", "create_worktree", "create_pr"]
        );
        for t in tools.as_array().unwrap() {
            assert!(
                t["inputSchema"]["properties"].get("repo").is_none(),
                "{}",
                t["name"]
            );
        }
        assert!(tools[1]["inputSchema"]["properties"].get("issue").is_some());
    }
}
