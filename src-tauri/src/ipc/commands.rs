use std::path::PathBuf;

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent::{self, AgentBackendKind, AgentEvent, AgentSession, WorktreeActivity};
use crate::diff::{self, DiffSet};
use crate::fs_api::{self, FileContent, TreeEntry};
use crate::storage::{self, RecentWorkspace};
use crate::fs_watch;
use crate::ipc::events;
use crate::pty::{self, PtyEvent, TerminalSession};
use crate::state::AppState;
use crate::util::errors::{AppError, AppResult};
use crate::util::ids::{AgentSessionId, TerminalId, WorkspaceId, WorktreeId};
use crate::workspace::{self, Workspace};
use crate::worktree::{self, MergeResult, Worktree};

#[tauri::command]
pub async fn open_workspace(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Workspace> {
    let ws = workspace::open(&path, &state).await?;
    // Record it in the recent-workspaces list so Home can one-click back.
    // Best-effort: log and continue if it fails.
    if let Err(e) = storage::push_recent(&app, &ws.root).await {
        tracing::warn!(?e, "push_recent failed");
    }
    // Reconcile any pre-existing worktrees under <repo>__worktrees/.
    worktree::reconcile(ws.id, &state).await?;
    // Register the main clone as a synthetic sidebar entry.
    let _ = worktree::register_main_clone(ws.id, &state).await;
    // Start watchers + compute initial diffs for every adopted worktree,
    // including the main clone.
    for entry in state.worktrees.iter() {
        let wt = entry.value().clone();
        if wt.workspace_id != ws.id {
            continue;
        }
        prime_worktree_watch(&app, &wt);
    }
    Ok(ws)
}

#[tauri::command]
pub async fn list_recent_workspaces(app: AppHandle) -> AppResult<Vec<RecentWorkspace>> {
    storage::list_recent(&app).await
}

#[tauri::command]
pub async fn close_workspace(
    workspace_id: WorkspaceId,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    // Tear down everything tied to this workspace: agents, terminals,
    // watchers, cached diffs, then the worktrees and the workspace itself.
    // On-disk worktree dirs and their branches are left intact.
    let wt_ids: Vec<WorktreeId> = state
        .worktrees
        .iter()
        .filter(|e| e.value().workspace_id == workspace_id)
        .map(|e| *e.key())
        .collect();
    for id in &wt_ids {
        fs_watch::stop(&app, id);
        pty::manager::close_for_worktree(&state.terminals, *id);
        agent::supervisor::kill_for_worktree(&state.agents, *id);
        state.diffs.remove(id);
        state.worktrees.remove(id);
    }
    state.workspaces.remove(&workspace_id);
    tracing::info!(id = %workspace_id, worktrees = wt_ids.len(), "closed workspace");
    Ok(())
}

#[tauri::command]
pub async fn list_worktrees(
    workspace_id: WorkspaceId,
    state: State<'_, AppState>,
) -> AppResult<Vec<Worktree>> {
    Ok(worktree::list_for_workspace(workspace_id, &state))
}

#[tauri::command]
pub async fn create_worktree(
    workspace_id: WorkspaceId,
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Worktree> {
    let wt = worktree::create(workspace_id, &name, &state).await?;
    prime_worktree_watch(&app, &wt);
    let _ = app.emit(&events::worktrees_changed(workspace_id), ());
    Ok(wt)
}

#[tauri::command]
pub async fn remove_worktree(
    worktree_id: WorktreeId,
    force: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let workspace_id = state
        .worktrees
        .get(&worktree_id)
        .map(|e| e.value().workspace_id);

    fs_watch::stop(&app, &worktree_id);
    pty::manager::close_for_worktree(&state.terminals, worktree_id);
    agent::supervisor::kill_for_worktree(&state.agents, worktree_id);
    state.diffs.remove(&worktree_id);
    worktree::remove(worktree_id, force, &state).await?;

    if let Some(ws_id) = workspace_id {
        let _ = app.emit(&events::worktrees_changed(ws_id), ());
    }
    Ok(())
}

#[tauri::command]
pub async fn merge_worktree(
    worktree_id: WorktreeId,
    squash: bool,
    commit_message: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<MergeResult> {
    let workspace_id = state
        .worktrees
        .get(&worktree_id)
        .map(|e| e.value().workspace_id);
    let result = worktree::merge(worktree_id, squash, commit_message, &state).await?;
    // On a clean merge we DON'T auto-remove the worktree — keep it around so
    // the user can inspect or continue iterating. They can hit the ✕ button
    // to delete it when they're done.
    if let (Some(ws_id), MergeResult::Clean) = (workspace_id, &result) {
        let _ = app.emit(&events::worktrees_changed(ws_id), ());
    }
    Ok(result)
}

// --- Agents ---

#[tauri::command]
pub async fn launch_agent(
    worktree_id: WorktreeId,
    backend: AgentBackendKind,
    argv: Option<Vec<String>>,
    cols: u16,
    rows: u16,
    channel: Channel<AgentEvent>,
    state: State<'_, AppState>,
) -> AppResult<AgentSession> {
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();
    agent::supervisor::launch(
        &state.agents,
        worktree_id,
        wt.path,
        wt.is_main_clone,
        backend,
        argv,
        cols,
        rows,
        channel,
    )
}

#[tauri::command]
pub async fn agent_write(
    agent_id: AgentSessionId,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    agent::supervisor::write_stdin(&state.agents, agent_id, &data)
}

#[tauri::command]
pub async fn agent_resize(
    agent_id: AgentSessionId,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> AppResult<()> {
    agent::supervisor::resize(&state.agents, agent_id, cols, rows)
}

#[tauri::command]
pub async fn kill_agent(
    agent_id: AgentSessionId,
    state: State<'_, AppState>,
) -> AppResult<()> {
    agent::supervisor::kill(&state.agents, agent_id);
    Ok(())
}

#[tauri::command]
pub async fn list_agents_for_worktree(
    worktree_id: WorktreeId,
    state: State<'_, AppState>,
) -> AppResult<Vec<AgentSession>> {
    Ok(state.agents.list_for_worktree(worktree_id))
}

#[tauri::command]
pub async fn list_agent_activity(
    workspace_id: WorkspaceId,
    state: State<'_, AppState>,
) -> AppResult<Vec<WorktreeActivity>> {
    let wts = worktree::list_for_workspace(workspace_id, &state);
    let ws = state
        .workspaces
        .get(&workspace_id)
        .map(|e| e.value().clone());

    let mut out = Vec::with_capacity(wts.len());
    for w in wts {
        let (ahead, behind) = if w.is_main_clone {
            (0, 0)
        } else if let Some(ref ws) = ws {
            // Resolve against the base ref captured at creation (workspace
            // default branch). Best-effort: any git failure leaves (0, 0).
            crate::worktree::git_ops::ahead_behind(&ws.root, &ws.default_branch, &w.branch)
                .await
                .unwrap_or((0, 0))
        } else {
            (0, 0)
        };
        out.push(WorktreeActivity {
            worktree_id: w.id,
            activity: state.agents.activity_for_worktree(w.id),
            ahead,
            behind,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn attach_agent(
    agent_id: AgentSessionId,
    channel: Channel<AgentEvent>,
    state: State<'_, AppState>,
) -> AppResult<AgentSession> {
    agent::supervisor::attach(&state.agents, agent_id, channel)
}

#[tauri::command]
pub async fn open_terminal(
    worktree_id: WorktreeId,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    channel: Channel<PtyEvent>,
    state: State<'_, AppState>,
) -> AppResult<TerminalSession> {
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();
    let cwd: PathBuf = wt.path;
    pty::manager::open(&state.terminals, worktree_id, cwd, shell, cols, rows, channel)
}

#[tauri::command]
pub async fn pty_write(
    terminal_id: TerminalId,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    pty::manager::write(&state.terminals, terminal_id, &data)
}

#[tauri::command]
pub async fn pty_resize(
    terminal_id: TerminalId,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> AppResult<()> {
    pty::manager::resize(&state.terminals, terminal_id, cols, rows)
}

#[tauri::command]
pub async fn close_terminal(
    terminal_id: TerminalId,
    state: State<'_, AppState>,
) -> AppResult<()> {
    pty::manager::close(&state.terminals, terminal_id);
    Ok(())
}

#[tauri::command]
pub async fn read_file(
    worktree_id: WorktreeId,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<FileContent> {
    fs_api::read_worktree_file(worktree_id, &path, &state).await
}

#[tauri::command]
pub async fn list_tree(
    worktree_id: WorktreeId,
    dir: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<TreeEntry>> {
    fs_api::list_tree(worktree_id, &dir, &state).await
}

#[tauri::command]
pub async fn get_diff(
    worktree_id: WorktreeId,
    state: State<'_, AppState>,
) -> AppResult<DiffSet> {
    if let Some(cached) = state.diffs.get(&worktree_id) {
        return Ok(cached.clone());
    }
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();
    let computed = tokio::task::spawn_blocking(move || {
        diff::compute::compute(wt.id, &wt.path, &wt.base_ref)
    })
    .await
    .map_err(|e| AppError::Unknown(format!("diff task join: {e}")))??;
    state.diffs.insert(worktree_id, computed.clone());
    Ok(computed)
}

/// Start the file watcher for a worktree and kick off an initial diff compute.
/// Both are best-effort: failures are logged but don't block the caller.
fn prime_worktree_watch(app: &AppHandle, wt: &Worktree) {
    let app_clone = app.clone();
    let worktree_id = wt.id;
    let worktree_path = wt.path.clone();
    let base_ref = wt.base_ref.clone();

    if let Err(e) = fs_watch::start(app.clone(), worktree_id, worktree_path.clone(), base_ref.clone()) {
        tracing::warn!(?e, "fs_watch start failed");
    }

    // Initial diff compute off the main thread.
    tauri::async_runtime::spawn(async move {
        let res = tokio::task::spawn_blocking(move || {
            diff::compute::compute(worktree_id, &worktree_path, &base_ref)
        })
        .await;
        match res {
            Ok(Ok(d)) => {
                let state = app_clone.state::<AppState>();
                state.diffs.insert(worktree_id, d.clone());
                let _ = app_clone.emit(&events::diff_updated(worktree_id), &d);
            }
            Ok(Err(e)) => tracing::warn!(?e, "initial diff compute failed"),
            Err(e) => tracing::warn!(?e, "initial diff task join failed"),
        }
    });
}
