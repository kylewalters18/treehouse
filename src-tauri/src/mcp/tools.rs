//! Tool definitions + dispatch. Tool failures are reported MCP-style — a
//! normal result with `isError: true` — so the calling agent can read the
//! reason and relay it, rather than seeing a protocol error.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent::supervisor;
use crate::forge::{
    log, workflow, AssigneeFilter, Forge, ForgeIssue, ForgePipeline, ForgeThread, IssueQuery,
    IssueStart,
};
use crate::ipc::commands::{finish_create, resolve_forge};
use crate::ipc::events;
use crate::pty;
use crate::state::AppState;
use crate::storage;
use crate::util::ids::WorkspaceId;
use crate::worktree::{self, git_ops, CreateOptions, Worktree};

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
            get_linked_issue_schema(),
            search_issues_schema(scope),
            get_issue_schema(scope),
            update_issue_schema(scope),
            get_pr_threads_schema(),
            get_ci_status_schema(),
            get_ci_log_schema(),
            wait_for_ci_schema(),
            retry_ci_job_schema(),
            get_terminal_output_schema(),
        ]),
        // A planner has a repo but no worktree, so nothing to open a PR from.
        CallerScope::Planner(_) => {
            json!([
                create_issue_schema(scope),
                create_worktree_schema(scope),
                search_issues_schema(scope),
                get_issue_schema(scope),
                update_issue_schema(scope),
            ])
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
            search_issues_schema(scope),
            get_issue_schema(scope),
            update_issue_schema(scope),
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

const SEARCH_ISSUES_DEFAULT_LIMIT: u32 = 20;
const SEARCH_ISSUES_MAX_LIMIT: u32 = 50;

fn search_issues_schema(scope: CallerScope) -> Value {
    let mut properties = json!({
        "query": {
            "type": "string",
            "description": "Keywords matched against title and description. Omit to list the most \
                recently updated issues."
        },
        "labels": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Only issues carrying ALL of these labels."
        },
        "assignee": {
            "type": "string",
            "description": "A username, \"@me\" for the authenticated user, or \"none\" for \
                unassigned issues."
        },
        "state": {
            "type": "string",
            "enum": ["open", "closed", "all"],
            "description": "Default open."
        },
        "limit": {
            "type": "integer",
            "description": format!(
                "Max results, newest-updated first. Default {SEARCH_ISSUES_DEFAULT_LIMIT}, \
                 max {SEARCH_ISSUES_MAX_LIMIT}."
            )
        }
    });
    let mut required: Vec<&str> = vec![];
    if scope == CallerScope::Scratch {
        properties["repo"] = repo_property();
        required.push("repo");
    }
    json!({
        "name": "search_issues",
        "description": "Search this repo's GitLab/GitHub issues. Returns compact rows (number, title, \
            state, labels, assignees, updated) without descriptions — call get_issue for the full \
            text of the ones that matter. Narrow with filters rather than paging through a big \
            backlog, and search for an existing issue before calling create_issue.",
        "inputSchema": { "type": "object", "properties": properties, "required": required }
    })
}

fn get_issue_schema(scope: CallerScope) -> Value {
    let mut properties = json!({
        "number": { "type": "integer", "description": "Issue number (GitLab iid)." }
    });
    let mut required = vec!["number"];
    if scope == CallerScope::Scratch {
        properties["repo"] = repo_property();
        required.insert(0, "repo");
    }
    json!({
        "name": "get_issue",
        "description": "Read one of this repo's issues in full: title, state, description, labels, \
            assignees, URL.",
        "inputSchema": { "type": "object", "properties": properties, "required": required }
    })
}

fn update_issue_schema(scope: CallerScope) -> Value {
    let mut properties = json!({
        "number": { "type": "integer", "description": "Issue number (GitLab iid)." },
        "title": { "type": "string", "description": "New title. Omit to keep the current one." },
        "body": {
            "type": "string",
            "description": "New description, replacing the whole current one. Omit to keep it."
        },
        "expected_updated_at": {
            "type": "string",
            "description": "The `updatedAt` from your last get_issue. When given, the edit is \
                refused if the issue changed since — e.g. a person edited it — so you don't \
                overwrite their change. Strongly recommended when changing `body`."
        }
    });
    let mut required = vec!["number"];
    if scope == CallerScope::Scratch {
        properties["repo"] = repo_property();
        required.insert(0, "repo");
    }
    json!({
        "name": "update_issue",
        "description": "Edit one of this repo's issues: its title and/or description (visible to \
            the team). Read it with get_issue first — `body` replaces the whole description, so \
            start from the current text.",
        "inputSchema": { "type": "object", "properties": properties, "required": required }
    })
}

fn create_pr_schema() -> Value {
    json!({
        "name": "create_pr",
        "description": "Open a pull/merge request for THIS worktree's branch against the branch it \
            was created from. It never pushes: commit, then `git push -u origin <branch>` first — \
            treehouse never commits for you, and this refuses when the branch has no commits ahead \
            of its base. When this worktree is \
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

fn get_linked_issue_schema() -> Value {
    json!({
        "name": "get_linked_issue",
        "description": "Read the issue THIS worktree is linked to (title, state, description, labels, \
            URL) — e.g. to recover the task after a resume. Errors when no issue is linked.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

fn get_pr_threads_schema() -> Value {
    json!({
        "name": "get_pr_threads",
        "description": "Read the review threads and comments on THIS worktree's open pull/merge \
            request: who said what, and the file/line for inline comments. Resolved threads are \
            left out unless include_resolved is true. Read-only — make the changes, commit, and \
            push; you can't reply to or resolve threads.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "include_resolved": {
                    "type": "boolean",
                    "description": "Also return resolved threads. Default false."
                }
            }
        }
    })
}

fn get_ci_status_schema() -> Value {
    json!({
        "name": "get_ci_status",
        "description": "The latest CI pipeline for THIS worktree's branch: its status, the commit it \
            ran on (and whether that is your local HEAD), and each job's id, name, stage, and \
            status. Pass a failed job's id to get_ci_log to see why. CI only runs on pushed commits.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

fn get_ci_log_schema() -> Value {
    json!({
        "name": "get_ci_log",
        "description": "The log of one CI job (an id from get_ci_status), as plain text. Long logs are \
            cut to their last ~16KB, where failures usually are.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "job_id": { "type": "integer", "description": "Job id from get_ci_status." }
            },
            "required": ["job_id"]
        }
    })
}

fn wait_for_ci_schema() -> Value {
    json!({
        "name": "wait_for_ci",
        "description": "Wait for CI on THIS worktree's pushed HEAD to finish, then return its \
            result in get_ci_status's shape. Push first — this errors if HEAD isn't on origin. \
            Returns early if no run appears for HEAD within ~3 minutes, and with `timedOut` if \
            still running at the timeout (call again to keep waiting). On failure, read the \
            failed job with get_ci_log.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "timeout_secs": {
                    "type": "integer",
                    "description": "How long to wait, 30–1800. Default 600."
                }
            }
        }
    })
}

fn retry_ci_job_schema() -> Value {
    json!({
        "name": "retry_ci_job",
        "description": "Re-run one finished job (an id from get_ci_status) of THIS worktree's latest \
            pipeline — for failures you've judged flaky or infrastructural from the log, not ones \
            your code caused. Then call wait_for_ci.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "job_id": { "type": "integer", "description": "Job id from get_ci_status." }
            },
            "required": ["job_id"]
        }
    })
}

fn get_terminal_output_schema() -> Value {
    json!({
        "name": "get_terminal_output",
        "description": "Read recent output from the user's terminal tabs in THIS worktree in \
            treehouse (not your own shell) — e.g. a dev server's errors or a test run the user \
            started. With one terminal open, returns its output; with several, call without \
            `terminal` first to list them (number, what each is running, its last line), then \
            pass the number. Escape codes are stripped; full-screen apps won't read well.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "terminal": {
                    "type": "integer",
                    "description": "Which terminal, by the number from the listing."
                },
                "lines": {
                    "type": "integer",
                    "description": "How many of the most recent lines to return, 1–2000. Default 200."
                }
            }
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
        "get_linked_issue" => get_linked_issue(app, caller).await,
        "search_issues" => search_issues(app, caller, &args).await,
        "get_issue" => get_issue(app, caller, &args).await,
        "update_issue" => update_issue(app, caller, &args).await,
        "get_pr_threads" => get_pr_threads(app, caller, &args).await,
        "get_ci_status" => get_ci_status(app, caller).await,
        "get_ci_log" => get_ci_log(app, caller, &args).await,
        "wait_for_ci" => wait_for_ci(app, caller, &args).await,
        "retry_ci_job" => retry_ci_job(app, caller, &args).await,
        "get_terminal_output" => get_terminal_output(app, caller, &args).await,
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
    let _ = app.emit(&events::issues_changed(workspace_id), issue.number);
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

/// The calling agent's own worktree, for tools that act on "this worktree".
fn own_worktree(app: &AppHandle, caller: McpCaller, tool: &str) -> Result<Worktree, String> {
    let CallerScope::Worktree(id) = caller.scope else {
        return Err(format!(
            "{tool} reads the calling worktree's state; this agent has none"
        ));
    };
    app.state::<AppState>()
        .worktrees
        .get(&id)
        .map(|e| e.value().clone())
        .ok_or_else(|| "the calling worktree no longer exists".into())
}

async fn own_forge(app: &AppHandle, wt: &Worktree) -> Result<Forge, String> {
    let state = app.state::<AppState>();
    resolve_forge(wt.workspace_id, &state)
        .await
        .map(|(forge, _)| forge)
        .map_err(|e| e.to_string())
}

/// A forge for whichever repo the call targets (see `target_workspace`).
async fn target_forge(app: &AppHandle, caller: McpCaller, args: &Value) -> Result<Forge, String> {
    let (workspace_id, _) = target_workspace(app, caller, args)?;
    let state = app.state::<AppState>();
    resolve_forge(workspace_id, &state)
        .await
        .map(|(forge, _)| forge)
        .map_err(|e| e.to_string())
}

fn issue_query(args: &Value) -> Result<IssueQuery, String> {
    let labels = match args.get("labels") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(xs)) => xs
            .iter()
            .map(|x| x.as_str().map(str::trim).ok_or("`labels` must be strings"))
            .filter(|l| l.map_or(true, |l| !l.is_empty()))
            .map(|l| l.map(str::to_string))
            .collect::<Result<_, _>>()?,
        Some(_) => return Err("`labels` must be an array of strings".into()),
    };
    let assignee = AssigneeFilter::parse(&str_arg(args, "assignee").unwrap_or_default());
    let state = str_arg(args, "state").unwrap_or_else(|| "open".into());
    if !matches!(state.as_str(), "open" | "closed" | "all") {
        return Err(format!(
            "`state` must be open, closed, or all (got {state})"
        ));
    }
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map_or(SEARCH_ISSUES_DEFAULT_LIMIT, |n| {
            (n as u32).clamp(1, SEARCH_ISSUES_MAX_LIMIT)
        });
    Ok(IssueQuery {
        search: str_arg(args, "query").unwrap_or_default(),
        state,
        labels,
        assignee,
        limit,
    })
}

async fn search_issues(app: &AppHandle, caller: McpCaller, args: &Value) -> Result<Value, String> {
    let q = issue_query(args)?;
    let issues = target_forge(app, caller, args)
        .await?
        .list_issues(&q)
        .await
        .map_err(|e| e.to_string())?;
    let rows: Vec<Value> = issues
        .into_iter()
        .map(|i| {
            json!({
                "number": i.number,
                "title": i.title,
                "state": i.state,
                "labels": i.labels,
                "assignees": i.assignees,
                "updatedAt": i.updated_at,
            })
        })
        .collect();
    Ok(json!({ "count": rows.len(), "limit": q.limit, "issues": rows }))
}

async fn get_issue(app: &AppHandle, caller: McpCaller, args: &Value) -> Result<Value, String> {
    let n = args
        .get("number")
        .and_then(Value::as_u64)
        .ok_or("`number` is required")?;
    let issue = target_forge(app, caller, args)
        .await?
        .get_issue(n)
        .await
        .map_err(|e| format!("couldn't read #{n}: {e}"))?;
    Ok(issue_json(issue))
}

async fn update_issue(app: &AppHandle, caller: McpCaller, args: &Value) -> Result<Value, String> {
    let n = args
        .get("number")
        .and_then(Value::as_u64)
        .ok_or("`number` is required")?;
    let title = str_arg(args, "title");
    // An empty body is a real edit (clearing it); only absence keeps it.
    let body = args.get("body").and_then(Value::as_str).map(str::to_string);
    if title.is_none() && body.is_none() {
        return Err("nothing to change — pass `title` and/or `body`".into());
    }
    let expected = str_arg(args, "expected_updated_at");
    let (workspace_id, _) = target_workspace(app, caller, args)?;
    let state = app.state::<AppState>();
    let (forge, _) = resolve_forge(workspace_id, &state)
        .await
        .map_err(|e| e.to_string())?;
    let current = forge
        .get_issue(n)
        .await
        .map_err(|e| format!("couldn't read #{n}: {e}"))?;
    if let Some(expected) = &expected {
        if &current.updated_at != expected {
            return Err(format!(
                "#{n} changed since your get_issue (updatedAt is now {}) — read it again and \
                 reapply your edit to the current text",
                current.updated_at
            ));
        }
    }
    let issue = forge
        .update_issue(
            n,
            title.as_deref().unwrap_or(&current.title),
            body.as_deref().unwrap_or(&current.body),
            None,
        )
        .await
        .map_err(|e| format!("couldn't update #{n}: {e}"))?;
    tracing::info!(number = n, "mcp: updated issue");
    let _ = app.emit(&events::issues_changed(workspace_id), n);
    Ok(json!({ "number": issue.number, "url": issue.url, "updatedAt": issue.updated_at }))
}

fn issue_json(issue: ForgeIssue) -> Value {
    json!({
        "number": issue.number,
        "title": issue.title,
        "state": issue.state,
        "body": issue.body,
        "labels": issue.labels,
        "assignees": issue.assignees,
        "url": issue.url,
        "updatedAt": issue.updated_at,
    })
}

async fn get_linked_issue(app: &AppHandle, caller: McpCaller) -> Result<Value, String> {
    let wt = own_worktree(app, caller, "get_linked_issue")?;
    let n = workflow::linked_issue(app, &wt.path)
        .await
        .ok_or_else(|| format!("{} isn't linked to an issue", wt.branch))?;
    let issue = own_forge(app, &wt)
        .await?
        .get_issue(n)
        .await
        .map_err(|e| format!("couldn't read #{n}: {e}"))?;
    Ok(issue_json(issue))
}

async fn get_pr_threads(app: &AppHandle, caller: McpCaller, args: &Value) -> Result<Value, String> {
    let include_resolved = args
        .get("include_resolved")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let wt = own_worktree(app, caller, "get_pr_threads")?;
    let forge = own_forge(app, &wt).await?;
    let mr = forge
        .find_mr_for_branch(&wt.branch)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("{} has no open pull/merge request", wt.branch))?;
    let threads = forge
        .list_threads(mr.number)
        .await
        .map_err(|e| e.to_string())?;
    let total = threads.len();
    let threads: Vec<Value> = threads
        .into_iter()
        .filter(|t| include_resolved || !t.resolved)
        .map(thread_json)
        .collect();
    Ok(json!({
        "pr": { "number": mr.number, "title": mr.title, "url": mr.url, "mergeStatus": mr.merge_status },
        "threads": threads,
        "hiddenResolved": total - threads.len(),
    }))
}

/// A thread for an agent: where it's anchored (from its first note) and the
/// conversation, without the forge's ids for individual notes.
fn thread_json(t: ForgeThread) -> Value {
    let anchor = t.notes.first().and_then(|n| n.position.as_ref()).map(|p| {
        match (&p.new_path, p.new_line) {
            (Some(path), Some(line)) => json!({ "file": path, "line": line }),
            _ => json!({
                "file": p.old_path.as_ref().or(p.new_path.as_ref()),
                "line": p.old_line,
                "side": "old",
            }),
        }
    });
    let notes: Vec<Value> = t
        .notes
        .iter()
        .map(|n| json!({ "author": n.author, "body": n.body, "createdAt": n.created_at }))
        .collect();
    json!({
        "id": t.id,
        "resolved": t.resolved,
        "inline": anchor,
        "notes": notes,
    })
}

async fn get_ci_status(app: &AppHandle, caller: McpCaller) -> Result<Value, String> {
    let wt = own_worktree(app, caller, "get_ci_status")?;
    let forge = own_forge(app, &wt).await?;
    let head = git_ops::rev_parse(&wt.path, "HEAD").await.ok();
    let pipelines = forge
        .list_pipelines(&wt.branch)
        .await
        .map_err(|e| e.to_string())?;
    match pipelines.into_iter().next() {
        Some(p) => ci_report(&forge, &wt, &p, head.as_deref()).await,
        None => Ok(json!({
            "branch": wt.branch,
            "pipeline": null,
            "note": "no CI runs for this branch — it may not be pushed yet, or CI isn't set up",
        })),
    }
}

/// A pipeline and the current run of each of its jobs, as the CI tools
/// report it.
async fn ci_report(
    forge: &Forge,
    wt: &Worktree,
    p: &ForgePipeline,
    head: Option<&str>,
) -> Result<Value, String> {
    let jobs = forge.pipeline_jobs(p.id).await.map_err(|e| e.to_string())?;
    let jobs: Vec<Value> = crate::forge::latest_jobs(jobs)
        .into_iter()
        .map(|j| {
            json!({
                "id": j.id,
                "name": j.name,
                "stage": j.stage,
                "status": j.status,
                "attempt": j.attempt,
                "allowFailure": j.allow_failure,
            })
        })
        .collect();
    let is_head = head == Some(p.sha.as_str());
    Ok(json!({
        "branch": wt.branch,
        "pipeline": {
            "status": p.status,
            "sha": p.sha,
            "isLocalHead": is_head,
            "url": p.web_url,
            "createdAt": p.created_at,
        },
        "jobs": jobs,
        "note": (!is_head).then_some(
            "this pipeline ran on an older commit than your HEAD — push, or wait for the new run"
        ),
    }))
}

/// Pipeline states that won't change without someone acting.
const CI_SETTLED: &[&str] = &["success", "failed", "canceled", "skipped", "manual"];
const CI_POLL: Duration = Duration::from_secs(15);
/// How long a pushed HEAD may go without any pipeline before we decide CI
/// isn't going to run on it.
const CI_APPEAR_GRACE: Duration = Duration::from_secs(180);

/// Block until CI for the pushed HEAD settles, then report it like
/// get_ci_status. Gives up early when HEAD isn't pushed (no run will ever
/// come) or no run appears for it, and stops if the calling agent exits.
async fn wait_for_ci(app: &AppHandle, caller: McpCaller, args: &Value) -> Result<Value, String> {
    let timeout = args
        .get("timeout_secs")
        .and_then(Value::as_u64)
        .unwrap_or(600)
        .clamp(30, 1800);
    let wt = own_worktree(app, caller, "wait_for_ci")?;
    let forge = own_forge(app, &wt).await?;
    let head = git_ops::rev_parse(&wt.path, "HEAD")
        .await
        .map_err(|e| e.to_string())?;
    let pushed = git_ops::rev_parse(&wt.path, &format!("refs/remotes/origin/{}", wt.branch))
        .await
        .ok();
    if pushed.as_deref() != Some(head.as_str()) {
        return Err(format!(
            "HEAD ({}) isn't pushed to origin/{} — push first; CI only runs on pushed commits",
            &head[..head.len().min(7)],
            wt.branch
        ));
    }

    let started = Instant::now();
    loop {
        let pipelines = forge
            .list_pipelines(&wt.branch)
            .await
            .map_err(|e| e.to_string())?;
        let ours = pipelines.into_iter().find(|p| p.sha == head);
        let waited = started.elapsed();
        match &ours {
            Some(p) if CI_SETTLED.contains(&p.status.as_str()) => {
                let mut report = ci_report(&forge, &wt, p, Some(&head)).await?;
                report["waitedSecs"] = json!(waited.as_secs());
                return Ok(report);
            }
            None if waited >= CI_APPEAR_GRACE => {
                return Ok(json!({
                    "branch": wt.branch,
                    "pipeline": null,
                    "waitedSecs": waited.as_secs(),
                    "note": "no CI run appeared for HEAD — CI may not run on this branch",
                }));
            }
            _ => {}
        }
        if waited >= Duration::from_secs(timeout) {
            let mut report = match &ours {
                Some(p) => ci_report(&forge, &wt, p, Some(&head)).await?,
                None => json!({ "branch": wt.branch, "pipeline": null }),
            };
            report["timedOut"] = json!(true);
            report["waitedSecs"] = json!(waited.as_secs());
            report["note"] = json!("still running — call wait_for_ci again to keep waiting");
            return Ok(report);
        }
        tokio::time::sleep(CI_POLL).await;
        let state = app.state::<AppState>();
        if !supervisor::is_live(&state.agents, caller.agent_id) {
            return Err("the calling agent exited".into());
        }
    }
}

/// Retry one job of THIS branch's latest pipeline.
async fn retry_ci_job(app: &AppHandle, caller: McpCaller, args: &Value) -> Result<Value, String> {
    let job_id = args
        .get("job_id")
        .and_then(Value::as_u64)
        .ok_or("`job_id` is required — take it from get_ci_status")?;
    let wt = own_worktree(app, caller, "retry_ci_job")?;
    let forge = own_forge(app, &wt).await?;
    let latest = forge
        .list_pipelines(&wt.branch)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .next()
        .ok_or_else(|| format!("{} has no CI runs", wt.branch))?;
    let jobs = forge
        .pipeline_jobs(latest.id)
        .await
        .map_err(|e| e.to_string())?;
    let job = crate::forge::latest_jobs(jobs)
        .into_iter()
        .find(|j| j.id == job_id)
        .ok_or_else(|| {
            format!(
                "job {job_id} isn't a current job of {}'s latest pipeline — take the id from get_ci_status",
                wt.branch
            )
        })?;
    if !["failed", "canceled", "success"].contains(&job.status.as_str()) {
        return Err(format!(
            "`{}` is {} — only finished jobs can be retried",
            job.name, job.status
        ));
    }
    forge.retry_job(job_id).await.map_err(|e| e.to_string())?;
    let _ = app.emit(&events::ci_changed(wt.workspace_id), wt.branch.clone());
    tracing::info!(job_id, branch = %wt.branch, "mcp: retried CI job");
    Ok(json!({
        "retried": job.name,
        "jobId": job_id,
        "note": "the retry runs as a new attempt with a new job id; call wait_for_ci to wait for it",
    }))
}

async fn get_ci_log(app: &AppHandle, caller: McpCaller, args: &Value) -> Result<Value, String> {
    let job_id = args
        .get("job_id")
        .and_then(Value::as_u64)
        .ok_or("`job_id` is required — take it from get_ci_status")?;
    let wt = own_worktree(app, caller, "get_ci_log")?;
    let log = own_forge(app, &wt)
        .await?
        .job_log(job_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "jobId": job_id, "log": log::plain_text(&log) }))
}

/// Read a user terminal's recent output. Terminals are numbered oldest
/// first; with several and no `terminal`, list them instead.
async fn get_terminal_output(
    app: &AppHandle,
    caller: McpCaller,
    args: &Value,
) -> Result<Value, String> {
    let lines = args
        .get("lines")
        .and_then(Value::as_u64)
        .unwrap_or(200)
        .clamp(1, 2000) as usize;
    let wt = own_worktree(app, caller, "get_terminal_output")?;
    let terms = pty::manager::outputs_for_worktree(&app.state::<AppState>().terminals, wt.id);
    if terms.is_empty() {
        return Err("no terminals are open in this worktree".into());
    }
    let pick = match args.get("terminal") {
        None | Some(Value::Null) if terms.len() == 1 => 1,
        None | Some(Value::Null) => {
            let mut listing = Vec::new();
            for (i, t) in terms.iter().enumerate() {
                let last = pty::text::render_tail(&t.bytes, 1);
                listing.push(json!({
                    "terminal": i + 1,
                    "running": running_command(t).await,
                    "alive": t.alive,
                    "lastLine": last,
                }));
            }
            return Ok(json!({
                "terminals": listing,
                "note": "pass `terminal` to read one",
            }));
        }
        Some(v) => v
            .as_u64()
            .filter(|n| (1..=terms.len() as u64).contains(n))
            .ok_or_else(|| format!("`terminal` must be 1–{}", terms.len()))?
            as usize,
    };
    let t = &terms[pick - 1];
    Ok(json!({
        "terminal": pick,
        "running": running_command(t).await,
        "alive": t.alive,
        "output": pty::text::render_tail(&t.bytes, lines),
    }))
}

/// The command in a terminal's foreground, or `None` when the shell is idle
/// at its prompt (or the process is gone).
async fn running_command(t: &pty::manager::TerminalOutput) -> Option<String> {
    let fg = t.foreground_pid?;
    if !t.alive || t.shell_pid == Some(fg as u32) {
        return None;
    }
    let out = tokio::process::Command::new("ps")
        .args(["-o", "command=", "-p", &fg.to_string()])
        .output()
        .await
        .ok()?;
    let cmd = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!cmd.is_empty()).then_some(cmd)
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
            [
                "list_repos",
                "create_issue",
                "create_worktree",
                "search_issues",
                "get_issue",
                "update_issue"
            ]
        );
        assert_eq!(
            tools[1]["inputSchema"]["required"],
            json!(["repo", "title", "body"])
        );
        assert_eq!(tools[2]["inputSchema"]["required"], json!(["repo"]));
        assert_eq!(tools[3]["inputSchema"]["required"], json!(["repo"]));
        assert_eq!(
            tools[4]["inputSchema"]["required"],
            json!(["repo", "number"])
        );
        assert_eq!(
            tools[5]["inputSchema"]["required"],
            json!(["repo", "number"])
        );
    }

    #[test]
    fn planners_act_on_their_repo_without_create_pr() {
        let tools = list(CallerScope::Planner(WorkspaceId::new()));
        assert_eq!(
            names(&tools),
            [
                "create_issue",
                "create_worktree",
                "search_issues",
                "get_issue",
                "update_issue"
            ]
        );
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
            [
                "create_issue",
                "create_worktree",
                "create_pr",
                "get_linked_issue",
                "search_issues",
                "get_issue",
                "update_issue",
                "get_pr_threads",
                "get_ci_status",
                "get_ci_log",
                "wait_for_ci",
                "retry_ci_job",
                "get_terminal_output",
            ]
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

    #[test]
    fn issue_query_parses_filters_and_clamps_limit() {
        let q = issue_query(&json!({
            "query": " flaky ",
            "labels": ["bug", " ", "ci"],
            "assignee": "None",
            "limit": 500
        }))
        .unwrap();
        assert_eq!(q.search, "flaky");
        assert_eq!(q.labels, ["bug", "ci"]);
        assert_eq!(q.assignee, AssigneeFilter::Unassigned);
        assert_eq!(q.state, "open");
        assert_eq!(q.limit, SEARCH_ISSUES_MAX_LIMIT);

        let q = issue_query(&json!({ "assignee": "@kyle", "state": "all" })).unwrap();
        assert_eq!(q.assignee, AssigneeFilter::User("kyle".into()));
        assert_eq!(q.limit, SEARCH_ISSUES_DEFAULT_LIMIT);
        assert_eq!(
            issue_query(&json!({ "assignee": "@me" })).unwrap().assignee,
            AssigneeFilter::Me
        );

        assert!(issue_query(&json!({ "state": "merged" })).is_err());
        assert!(issue_query(&json!({ "labels": "bug" })).is_err());
    }

    #[test]
    fn thread_json_anchors_on_first_note() {
        use crate::forge::{ForgeNote, ForgePosition};
        let note = |pos: Option<ForgePosition>| ForgeNote {
            id: 1,
            author: "rev".into(),
            body: "nit".into(),
            position: pos,
            created_at: "t".into(),
        };
        let t = ForgeThread {
            id: "d1".into(),
            notes: vec![note(Some(ForgePosition {
                new_path: None,
                new_line: None,
                old_path: Some("a.rs".into()),
                old_line: Some(4),
            }))],
            resolvable: true,
            resolved: false,
        };
        assert_eq!(
            thread_json(t)["inline"],
            json!({ "file": "a.rs", "line": 4, "side": "old" })
        );
        let general = ForgeThread {
            id: "c1".into(),
            notes: vec![note(None)],
            resolvable: false,
            resolved: false,
        };
        assert_eq!(thread_json(general)["inline"], Value::Null);
    }
}
