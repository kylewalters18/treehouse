use std::path::PathBuf;

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent::{self, AgentBackendKind, AgentEvent, AgentSession, WorktreeActivity};
use crate::diff::{self, DiffSet};
use crate::fs_api::{self, FileContent, TreeEntry};
use crate::lsp::{self, LspConfig, LspEvent, LspServerSession};
use crate::storage::{self, Comment, RecentWorkspace, Settings};
use crate::fs_watch;
use crate::ipc::events;
use crate::pty::{self, PtyEvent, TerminalSession};
use crate::state::AppState;
use crate::util::errors::{AppError, AppResult};
use crate::util::ids::{AgentSessionId, LspServerId, TerminalId, WorkspaceId, WorktreeId};
use crate::workspace::{self, Workspace};
use crate::worktree::{
    self, CreateOptions, CreateWorktreeResult, MergeBackStrategy, MergeResult, SyncResult,
    SyncStrategy, Worktree,
};

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
pub async fn get_settings(app: AppHandle) -> AppResult<Settings> {
    storage::load_settings(&app).await
}

#[tauri::command]
pub async fn update_settings(
    settings: Settings,
    app: AppHandle,
) -> AppResult<Settings> {
    storage::save_settings(&app, &settings).await?;
    Ok(settings)
}

#[tauri::command]
pub async fn list_comments(app: AppHandle) -> AppResult<Vec<Comment>> {
    storage::load_comments(&app).await
}

/// Replace the whole comments file. Frontend manages mutations and writes
/// the resulting list back; the file is small enough that whole-file
/// rewrites are simpler than diff-based commands.
#[tauri::command]
pub async fn save_comments(
    comments: Vec<Comment>,
    app: AppHandle,
) -> AppResult<Vec<Comment>> {
    storage::save_comments(&app, &comments).await?;
    Ok(comments)
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
        lsp::supervisor::kill_for_worktree(&state.lsp, *id);
        state.diffs.remove(id);
        state.worktrees.remove(id);
    }
    let _ = app.emit(&events::lsp_servers_changed(workspace_id), ());
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
    init_submodules: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<CreateWorktreeResult> {
    let result = worktree::create(
        workspace_id,
        &name,
        CreateOptions { init_submodules },
        &state,
    )
    .await?;
    prime_worktree_watch(&app, &result.worktree);
    let _ = app.emit(&events::worktrees_changed(workspace_id), ());
    Ok(result)
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
    lsp::supervisor::kill_for_worktree(&state.lsp, worktree_id);
    state.diffs.remove(&worktree_id);
    worktree::remove(worktree_id, force, &state).await?;

    if let Some(ws_id) = workspace_id {
        let _ = app.emit(&events::worktrees_changed(ws_id), ());
        let _ = app.emit(&events::lsp_servers_changed(ws_id), ());
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_worktree(
    worktree_id: WorktreeId,
    strategy: SyncStrategy,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<SyncResult> {
    let result = worktree::sync_with_default(worktree_id, strategy, &state).await?;
    if matches!(result, SyncResult::Clean { .. }) {
        // base_ref just advanced; force a recompute + emit since most of
        // the sync file churn has already debounced and the final state may
        // not have triggered another event.
        fs_watch::recompute_and_emit(&app, worktree_id);
    }
    Ok(result)
}

#[tauri::command]
pub async fn merge_worktree(
    worktree_id: WorktreeId,
    strategy: MergeBackStrategy,
    commit_message: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<MergeResult> {
    let workspace_id = state
        .worktrees
        .get(&worktree_id)
        .map(|e| e.value().workspace_id);
    let result = worktree::merge(worktree_id, strategy, commit_message, &state).await?;
    // On a clean merge we DON'T auto-remove the worktree — keep it around so
    // the user can inspect or continue iterating. They can hit the ✕ button
    // to delete it when they're done.
    if let (Some(ws_id), MergeResult::Clean) = (workspace_id, &result) {
        let _ = app.emit(&events::worktrees_changed(ws_id), ());
        // base_ref just advanced for both the merged worktree AND the main
        // clone (the merge ran there — its HEAD + workdir moved). Neither
        // triggers a useful fs event; explicitly recompute both so the
        // Changes list refreshes wherever the user happens to be looking.
        fs_watch::recompute_and_emit(&app, worktree_id);
        let main_clone_id: Option<WorktreeId> = state
            .worktrees
            .iter()
            .find(|e| e.value().workspace_id == ws_id && e.value().is_main_clone)
            .map(|e| *e.key());
        if let Some(id) = main_clone_id {
            fs_watch::recompute_and_emit(&app, id);
        }
    }
    Ok(result)
}

// --- Agents ---

#[tauri::command]
pub async fn launch_agent(
    app: AppHandle,
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
        &app,
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
            // Resolve the most up-to-date default-branch ref (local or
            // `origin/<default>`) so a stale local main doesn't inflate
            // ahead counts. Best-effort: any git failure leaves (0, 0).
            let base = crate::worktree::git_ops::resolve_default_base(
                &ws.root,
                &ws.default_branch,
            )
            .await;
            crate::worktree::git_ops::ahead_behind(&ws.root, &base, &w.branch)
                .await
                .unwrap_or((0, 0))
        } else {
            (0, 0)
        };
        let dirty = crate::worktree::git_ops::has_changes(&w.path)
            .await
            .unwrap_or(false);
        out.push(WorktreeActivity {
            worktree_id: w.id,
            activity: state.agents.activity_for_worktree(w.id),
            ahead,
            behind,
            dirty,
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
pub async fn attach_terminal(
    terminal_id: TerminalId,
    channel: Channel<PtyEvent>,
    state: State<'_, AppState>,
) -> AppResult<TerminalSession> {
    pty::manager::attach(&state.terminals, terminal_id, channel)
}

#[tauri::command]
pub async fn list_terminals_for_worktree(
    worktree_id: WorktreeId,
    state: State<'_, AppState>,
) -> AppResult<Vec<TerminalSession>> {
    Ok(pty::manager::list_for_worktree(&state.terminals, worktree_id))
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
    show_ignored: Option<bool>,
    state: State<'_, AppState>,
) -> AppResult<Vec<TreeEntry>> {
    fs_api::list_tree(worktree_id, &dir, show_ignored.unwrap_or(false), &state).await
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

// --- LSP ---

#[tauri::command]
pub async fn lsp_ensure(
    worktree_id: WorktreeId,
    language_id: String,
    file_path: String,
    channel: Channel<LspEvent>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<LspServerSession> {
    let configs = lsp::config::list(&app).await?;
    let config = configs
        .into_iter()
        .find(|c| c.id == language_id && c.enabled)
        .ok_or_else(|| {
            AppError::Unknown(format!("lsp language not enabled: {language_id}"))
        })?;

    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();

    let file_abs = std::path::PathBuf::from(&file_path);
    let root = lsp::root::resolve(&file_abs, &wt.path, &config.root_markers);

    let result = lsp::supervisor::ensure(&state.lsp, worktree_id, &config, root, channel)?;
    let _ = app.emit(&events::lsp_servers_changed(wt.workspace_id), ());
    Ok(result)
}

#[tauri::command]
pub async fn lsp_write(
    server_id: LspServerId,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    lsp::supervisor::write_stdin(&state.lsp, server_id, &data)
}

#[tauri::command]
pub async fn lsp_kill(
    server_id: LspServerId,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    // Capture workspace for the fan-out event before we tear down state.
    let workspace_id = state
        .lsp
        .list()
        .into_iter()
        .find(|s| s.id == server_id)
        .and_then(|s| state.worktrees.get(&s.worktree_id).map(|w| w.value().workspace_id));
    lsp::supervisor::kill(&state.lsp, server_id);
    if let Some(ws_id) = workspace_id {
        let _ = app.emit(&events::lsp_servers_changed(ws_id), ());
    }
    Ok(())
}

#[tauri::command]
pub async fn lsp_list(
    worktree_id: Option<WorktreeId>,
    state: State<'_, AppState>,
) -> AppResult<Vec<LspServerSession>> {
    Ok(match worktree_id {
        Some(id) => state.lsp.list_for_worktree(id),
        None => state.lsp.list(),
    })
}

#[tauri::command]
pub async fn lsp_list_configs(app: AppHandle) -> AppResult<Vec<LspConfig>> {
    lsp::config::list(&app).await
}

#[tauri::command]
pub async fn lsp_save_config(
    config: LspConfig,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Vec<LspConfig>> {
    // Toggling a language off must tear down any running instances of it;
    // otherwise Monaco would keep feeding a soon-to-be-orphaned server.
    let prev = lsp::config::list(&app).await?;
    let was_enabled = prev
        .iter()
        .find(|c| c.id == config.id)
        .map(|c| c.enabled)
        .unwrap_or(false);
    if was_enabled && !config.enabled {
        lsp::supervisor::kill_for_language(&state.lsp, &config.id);
    }
    lsp::config::upsert(&app, config).await
}

#[tauri::command]
pub async fn lsp_resolve_command(command: String) -> AppResult<Option<String>> {
    lsp::config::resolve_command(&command).await
}

/// Start the file watcher for a worktree and kick off an initial diff compute.
/// Both are best-effort: failures are logged but don't block the caller.
fn prime_worktree_watch(app: &AppHandle, wt: &Worktree) {
    let app_clone = app.clone();
    let worktree_id = wt.id;
    let worktree_path = wt.path.clone();
    let base_ref = wt.base_ref.clone();

    if let Err(e) = fs_watch::start(app.clone(), worktree_id, worktree_path.clone()) {
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
