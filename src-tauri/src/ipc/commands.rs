use std::path::PathBuf;

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent::{self, AgentBackendKind, AgentEvent, AgentSession, WorktreeActivity};
use crate::diff::{self, DiffMode, DiffSet};
use crate::forge::{
    self, ForgeApproval, ForgeIssue, ForgeJob, ForgeMr, ForgePipeline, ForgeStatus, ForgeThread,
    ReviewCommentInput,
};
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
    let mut ws = workspace::open(&path, &state).await?;
    // Apply the persisted per-workspace base-ref override (keyed by root path,
    // since worktree/workspace IDs are regenerated each launch). Mirror it into
    // both the live state entry — which `prime_worktree_watch` reads below for
    // the initial diff — and the returned value.
    if let Ok(settings) = storage::load_settings(&app).await {
        let key = ws.root.to_string_lossy().to_string();
        if let Some(base) = settings.base_refs.get(&key).cloned() {
            if let Some(mut entry) = state.workspaces.get_mut(&ws.id) {
                entry.base_ref_override = Some(base.clone());
            }
            ws.base_ref_override = Some(base);
        }
    }
    // Record it in the recent-workspaces list so Home can one-click back.
    // Best-effort: log and continue if it fails.
    if let Err(e) = storage::push_recent(&app, &ws.root).await {
        tracing::warn!(?e, "push_recent failed");
    }
    // Track in the persisted open-set so the next launch restores this
    // repo (multi-repo session restore). Best-effort.
    if let Err(e) = storage::push_open(&app, &ws.root).await {
        tracing::warn!(?e, "push_open failed");
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
    // Watch the worktrees root so worktrees created/removed outside
    // treehouse (e.g. a script running `git worktree add`) surface live.
    if let Err(e) = fs_watch::start_workspace(app.clone(), ws.id, ws.root.clone()) {
        tracing::warn!(?e, "fs_watch start_workspace failed");
    }
    // Seed the status cache so the first activity poll returns real data.
    worktree::status::recompute_all_for_workspace(&app, ws.id).await;
    Ok(ws)
}

#[tauri::command]
pub async fn list_recent_workspaces(app: AppHandle) -> AppResult<Vec<RecentWorkspace>> {
    storage::list_recent(&app).await
}

/// Open `url` in the host's default handler. Restricted to http/https
/// — anything else is rejected as a defensive measure, since the
/// frontend regex already filters but a renderer compromise would
/// otherwise hand us arbitrary `file://` / `ssh://` / `mailto:`
/// strings to shell out to.
#[tauri::command]
pub async fn open_external_url(url: String) -> AppResult<()> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(AppError::Unknown(format!(
            "open_external_url: only http/https schemes are allowed (got: {url})"
        )));
    }
    // macOS-only per project scope. `open` follows the user's default
    // browser association — same UX as clicking a link in any other
    // mac app.
    let status = std::process::Command::new("open")
        .arg(&url)
        .status()
        .map_err(|e| AppError::Unknown(format!("spawn open: {e}")))?;
    if !status.success() {
        return Err(AppError::Unknown(format!(
            "open exited non-zero ({:?}) for {url}",
            status.code()
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> AppResult<Settings> {
    storage::load_settings(&app).await
}

/// Persist new settings. Diffs LSP-language enabled state against
/// the previous settings: any language flipped from on → off has
/// its running servers killed across all worktrees, so Monaco isn't
/// left feeding bytes to a soon-to-be-orphaned process. Languages
/// flipped on don't need any sync action — they spawn lazily on
/// the next file open.
#[tauri::command]
pub async fn update_settings(
    settings: Settings,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Settings> {
    let prev = storage::load_settings(&app).await.unwrap_or_default();
    let prev_set: std::collections::HashSet<&str> = prev
        .enabled_lsp_languages
        .iter()
        .map(|s| s.as_str())
        .collect();
    let next_set: std::collections::HashSet<&str> = settings
        .enabled_lsp_languages
        .iter()
        .map(|s| s.as_str())
        .collect();
    for lang in prev_set.difference(&next_set) {
        lsp::supervisor::kill_for_language(&state.lsp, lang);
    }

    let mut to_save = settings.clone();
    to_save.enabled_lsp_languages.sort();
    to_save.enabled_lsp_languages.dedup();
    storage::save_settings(&app, &to_save).await?;
    Ok(to_save)
}

/// Set (or clear, with `None`) the per-workspace base ref the Changes
/// (Branch-view) diff compares against — e.g. `"origin/main"`, `"develop"`.
/// Persists by workspace root path, updates the in-memory workspace, and
/// recomputes every worktree's diff so the Changes list refreshes at once.
#[tauri::command]
pub async fn set_workspace_base_ref(
    workspace_id: WorkspaceId,
    base_ref: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Workspace> {
    // Treat blank / whitespace as "cleared" so the reset path and an empty
    // field both fall back to the origin/<default> default.
    let normalized = base_ref
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Scope the DashMap guard so it drops before the `.await` below.
    let ws = {
        let mut entry = state
            .workspaces
            .get_mut(&workspace_id)
            .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {workspace_id}")))?;
        entry.base_ref_override = normalized.clone();
        entry.value().clone()
    };

    let key = ws.root.to_string_lossy().to_string();
    let mut settings = storage::load_settings(&app).await.unwrap_or_default();
    match &normalized {
        Some(r) => {
            settings.base_refs.insert(key, r.clone());
        }
        None => {
            settings.base_refs.remove(&key);
        }
    }
    storage::save_settings(&app, &settings).await?;

    // Refresh the Changes list for every worktree in this workspace.
    let ids: Vec<WorktreeId> = state
        .worktrees
        .iter()
        .filter(|e| e.value().workspace_id == workspace_id)
        .map(|e| *e.key())
        .collect();
    for id in ids {
        fs_watch::recompute_and_emit(&app, id);
    }

    tracing::info!(id = %workspace_id, base_ref = ?normalized, "set workspace base ref");
    Ok(ws)
}

/// Branch refs (local heads + remote-tracking) for the Changes-pane base
/// picker. Read-only; no fetch.
#[tauri::command]
pub async fn list_branches(
    workspace_id: WorkspaceId,
    state: State<'_, AppState>,
) -> AppResult<Vec<String>> {
    let root = state
        .workspaces
        .get(&workspace_id)
        .map(|e| e.value().root.clone())
        .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {workspace_id}")))?;
    crate::worktree::git_ops::list_branches(&root).await
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
    fs_watch::stop_workspace(&app, &workspace_id);
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
    let removed_root = state
        .workspaces
        .remove(&workspace_id)
        .map(|(_, ws)| ws.root);
    if let Some(root) = removed_root {
        if let Err(e) = storage::remove_open(&app, &root).await {
            tracing::warn!(?e, "remove_open failed");
        }
    }
    tracing::info!(id = %workspace_id, worktrees = wt_ids.len(), "closed workspace");
    Ok(())
}

/// Return the workspaces currently open in this app session. Used by
/// the renderer to hydrate `useWorkspaceStore` on first mount —
/// AppState is the source of truth, and boot-time `restore_open_workspaces`
/// (lib.rs) has already opened anything that should be live.
#[tauri::command]
pub async fn list_workspaces(state: State<'_, AppState>) -> AppResult<Vec<Workspace>> {
    Ok(state
        .workspaces
        .iter()
        .map(|e| e.value().clone())
        .collect())
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
    base: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<CreateWorktreeResult> {
    let result = worktree::create(
        Some(&app),
        workspace_id,
        &name,
        CreateOptions { init_submodules, base },
        &state,
    )
    .await?;
    finish_create(&app, workspace_id, &result);
    Ok(result)
}

/// Post-create wiring shared by `create_worktree` and
/// `forge_create_worktree_from_issue`: start the watcher + initial diff,
/// kick a status recompute, and fan out the sidebar refresh signal.
fn finish_create(app: &AppHandle, workspace_id: WorkspaceId, result: &CreateWorktreeResult) {
    prime_worktree_watch(app, &result.worktree);
    worktree::status::spawn_recompute(app, result.worktree.id);
    let _ = app.emit(&events::worktrees_changed(workspace_id), ());
}

#[tauri::command]
pub async fn remove_worktree(
    worktree_id: WorktreeId,
    force: bool,
    skip_hook: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<worktree::setup::HookRunSummary> {
    let workspace_id = state
        .worktrees
        .get(&worktree_id)
        .map(|e| e.value().workspace_id);

    fs_watch::stop(&app, &worktree_id);
    pty::manager::close_for_worktree(&state.terminals, worktree_id);
    agent::supervisor::kill_for_worktree(&state.agents, worktree_id);
    lsp::supervisor::kill_for_worktree(&state.lsp, worktree_id);
    state.diffs.remove(&worktree_id);
    worktree::status::drop_for(&state, worktree_id);
    let hook_summary = worktree::remove(
        worktree_id,
        force,
        skip_hook.unwrap_or(false),
        Some(&app),
        &state,
    )
    .await?;

    if let Some(ws_id) = workspace_id {
        let _ = app.emit(&events::worktrees_changed(ws_id), ());
        let _ = app.emit(&events::lsp_servers_changed(ws_id), ());
    }
    Ok(hook_summary)
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
        worktree::status::spawn_recompute(&app, worktree_id);
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
        worktree::status::spawn_recompute(&app, worktree_id);
        let main_clone_id: Option<WorktreeId> = state
            .worktrees
            .iter()
            .find(|e| e.value().workspace_id == ws_id && e.value().is_main_clone)
            .map(|e| *e.key());
        if let Some(id) = main_clone_id {
            fs_watch::recompute_and_emit(&app, id);
            worktree::status::spawn_recompute(&app, id);
        }
        // Every other worktree in the workspace may now be squash-merged
        // or ff-caught-up; their `merged` / `ahead` might have flipped.
        let siblings: Vec<WorktreeId> = state
            .worktrees
            .iter()
            .filter(|e| {
                e.value().workspace_id == ws_id
                    && !e.value().is_main_clone
                    && *e.key() != worktree_id
            })
            .map(|e| *e.key())
            .collect();
        for id in siblings {
            worktree::status::spawn_recompute(&app, id);
        }
    }
    Ok(result)
}

// --- Forge (GitLab / GitHub via glab / gh) ---

/// Resolve the workspace root and build the active forge provider, using the
/// `forge_remotes` cache to avoid re-forking `git remote get-url` per call.
/// Errors with `AppError::Forge` when the workspace has no recognized remote.
async fn resolve_forge(
    workspace_id: WorkspaceId,
    state: &AppState,
) -> AppResult<(forge::Forge, PathBuf)> {
    let root = state
        .workspaces
        .get(&workspace_id)
        .map(|e| e.value().root.clone())
        .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {workspace_id}")))?;
    let remote = forge_remote(workspace_id, &root, state).await?;
    let remote =
        remote.ok_or_else(|| AppError::Forge("no recognized GitLab/GitHub remote".into()))?;
    Ok((forge::build(&remote, &root)?, root))
}

/// Get-or-detect the cached `RemoteInfo` for a workspace (caches negatives too).
async fn forge_remote(
    workspace_id: WorkspaceId,
    root: &std::path::Path,
    state: &AppState,
) -> AppResult<Option<forge::RemoteInfo>> {
    if let Some(cached) = state.forge_remotes.get(&workspace_id) {
        return Ok(cached.value().clone());
    }
    let detected = forge::detect(root).await?;
    state.forge_remotes.insert(workspace_id, detected.clone());
    Ok(detected)
}

/// Forge availability + auth. Always returns a well-formed status (never a hard
/// error) so the UI can render an install / `glab auth login` prompt — even
/// when the remote is unrecognized or absent.
#[tauri::command]
pub async fn forge_status(
    workspace_id: WorkspaceId,
    state: State<'_, AppState>,
) -> AppResult<ForgeStatus> {
    let root = match state.workspaces.get(&workspace_id).map(|e| e.value().root.clone()) {
        Some(r) => r,
        None => return Ok(unknown_status(None)),
    };
    match forge_remote(workspace_id, &root, &state).await? {
        Some(r) if !matches!(r.kind, forge::ForgeKind::Unknown) => {
            forge::build(&r, &root)?.status().await
        }
        other => Ok(unknown_status(other)),
    }
}

fn unknown_status(remote: Option<forge::RemoteInfo>) -> ForgeStatus {
    ForgeStatus {
        kind: remote.as_ref().map(|r| r.kind).unwrap_or(forge::ForgeKind::Unknown),
        host: remote.map(|r| r.host),
        installed: false,
        authenticated: false,
        username: None,
    }
}

#[tauri::command]
pub async fn forge_list_issues(
    workspace_id: WorkspaceId,
    query: String,
    state_filter: String,
    limit: u32,
    state: State<'_, AppState>,
) -> AppResult<Vec<ForgeIssue>> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.list_issues(&query, &state_filter, limit).await
}

#[tauri::command]
pub async fn forge_get_issue(
    workspace_id: WorkspaceId,
    number: u64,
    state: State<'_, AppState>,
) -> AppResult<ForgeIssue> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.get_issue(number).await
}

#[tauri::command]
pub async fn forge_set_issue_assignee(
    workspace_id: WorkspaceId,
    number: u64,
    assign: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.set_issue_assignee(number, assign).await
}

#[tauri::command]
pub async fn forge_list_mrs(
    workspace_id: WorkspaceId,
    state_filter: String,
    limit: u32,
    state: State<'_, AppState>,
) -> AppResult<Vec<ForgeMr>> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.list_mrs(&state_filter, limit).await
}

#[tauri::command]
pub async fn forge_find_mr_for_branch(
    workspace_id: WorkspaceId,
    branch: String,
    state: State<'_, AppState>,
) -> AppResult<Option<ForgeMr>> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.find_mr_for_branch(&branch).await
}

/// Push the branch to origin, then open an MR/PR. Body defaults to
/// `Closes #<n>` when the branch name carries an `<n>-…` issue prefix.
#[tauri::command]
pub async fn forge_create_mr(
    workspace_id: WorkspaceId,
    branch: String,
    title: String,
    body: Option<String>,
    draft: bool,
    state: State<'_, AppState>,
) -> AppResult<ForgeMr> {
    let (f, root) = resolve_forge(workspace_id, &state).await?;
    // Target the branch this worktree was forked from (chosen at create time),
    // falling back to the repo default for adopted worktrees we don't track.
    let target = state
        .worktrees
        .iter()
        .find(|e| e.value().workspace_id == workspace_id && e.value().branch == branch)
        .map(|e| e.value().base_branch.clone())
        .or_else(|| {
            state
                .workspaces
                .get(&workspace_id)
                .map(|e| e.value().default_branch.clone())
        })
        .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {workspace_id}")))?;
    worktree::git_ops::push_branch(&root, &branch).await?;
    let body = body.unwrap_or_else(|| match issue_number_from_branch(&branch) {
        Some(n) => format!("Closes #{n}"),
        None => String::new(),
    });
    f.create_mr(&branch, &target, &title, &body, draft).await
}

/// Parse a leading issue number from a `<n>-slug` branch name.
fn issue_number_from_branch(branch: &str) -> Option<u64> {
    branch.split('-').next()?.parse().ok()
}

#[tauri::command]
pub async fn forge_approve_mr(
    workspace_id: WorkspaceId,
    iid: u64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.approve_mr(iid).await
}

#[tauri::command]
pub async fn forge_unapprove_mr(
    workspace_id: WorkspaceId,
    iid: u64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.unapprove_mr(iid).await
}

#[tauri::command]
pub async fn forge_mr_approval(
    workspace_id: WorkspaceId,
    iid: u64,
    state: State<'_, AppState>,
) -> AppResult<ForgeApproval> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.approval_state(iid).await
}

#[tauri::command]
pub async fn forge_merge_mr(
    workspace_id: WorkspaceId,
    iid: u64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.merge_mr(iid).await
}

#[tauri::command]
pub async fn forge_post_mr_comment(
    workspace_id: WorkspaceId,
    iid: u64,
    body: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.post_mr_comment(iid, &body).await
}

#[tauri::command]
pub async fn forge_post_review_comments(
    workspace_id: WorkspaceId,
    iid: u64,
    comments: Vec<ReviewCommentInput>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.post_review_comments(iid, &comments).await
}

#[tauri::command]
pub async fn forge_resolve_thread(
    workspace_id: WorkspaceId,
    iid: u64,
    discussion_id: String,
    resolved: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.resolve_thread(iid, &discussion_id, resolved).await
}

#[tauri::command]
pub async fn forge_list_threads(
    workspace_id: WorkspaceId,
    iid: u64,
    state: State<'_, AppState>,
) -> AppResult<Vec<ForgeThread>> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.list_threads(iid).await
}

#[tauri::command]
pub async fn forge_reply_thread(
    workspace_id: WorkspaceId,
    iid: u64,
    discussion_id: String,
    body: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.reply_thread(iid, &discussion_id, &body).await
}

#[tauri::command]
pub async fn forge_list_pipelines(
    workspace_id: WorkspaceId,
    branch: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<ForgePipeline>> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.list_pipelines(&branch).await
}

#[tauri::command]
pub async fn forge_pipeline_jobs(
    workspace_id: WorkspaceId,
    pipeline_id: u64,
    state: State<'_, AppState>,
) -> AppResult<Vec<ForgeJob>> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.pipeline_jobs(pipeline_id).await
}

#[tauri::command]
pub async fn forge_retry_pipeline(
    workspace_id: WorkspaceId,
    pipeline_id: u64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.retry_pipeline(pipeline_id).await
}

#[tauri::command]
pub async fn forge_retry_job(
    workspace_id: WorkspaceId,
    job_id: u64,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.retry_job(job_id).await
}

#[tauri::command]
pub async fn forge_job_log(
    workspace_id: WorkspaceId,
    job_id: u64,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let (f, _) = resolve_forge(workspace_id, &state).await?;
    f.job_log(job_id).await
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

/// Discover the named sub-agents the backend's CLI knows about (e.g.
/// `claude agents list`, `kiro-cli agent list`). When `worktree_id` is
/// supplied the lookup runs in that worktree's path so workspace-scoped
/// agents (`<repo>/.claude/agents/`, `<repo>/.kiro/agents/`) are visible.
#[tauri::command]
pub async fn list_backend_agents(
    backend: AgentBackendKind,
    worktree_id: Option<WorktreeId>,
    state: State<'_, AppState>,
) -> AppResult<Vec<agent::BackendAgent>> {
    let cwd = worktree_id
        .and_then(|id| state.worktrees.get(&id).map(|w| w.path.clone()))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    Ok(agent::supervisor::list_backend_agents(backend, &cwd))
}

#[tauri::command]
pub async fn list_agent_activity(
    app: AppHandle,
    workspace_id: WorkspaceId,
    state: State<'_, AppState>,
) -> AppResult<Vec<WorktreeActivity>> {
    let wts = worktree::list_for_workspace(workspace_id, &state);
    let mut out = Vec::with_capacity(wts.len());
    for w in wts {
        // Read from the event-driven status cache. Miss → zeros, and kick
        // off a one-shot recompute so the next poll returns real numbers.
        let (ahead, behind, dirty, merged) = match state
            .worktree_status
            .get(&w.id)
            .map(|e| *e.value())
        {
            Some(s) => (s.ahead, s.behind, s.dirty, s.merged),
            None => {
                crate::worktree::status::spawn_recompute(&app, w.id);
                (0, 0, false, false)
            }
        };
        out.push(WorktreeActivity {
            worktree_id: w.id,
            activity: state.agents.activity_for_worktree(w.id),
            ahead,
            behind,
            dirty,
            merged,
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
pub async fn write_file(
    worktree_id: WorktreeId,
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    fs_api::write_worktree_file(worktree_id, &path, &content, &state).await
}

/// Read a file's content at a specific ref (branch / sha / tag). Used by
/// the DiffEditor to render the "before" side of a diff. Returns an empty
/// string when the path didn't exist at that ref — git's own behavior is
/// nonzero exit, which we normalize to empty so Monaco can show "added"
/// files as a pure-insertion diff without a separate error path.
#[tauri::command]
pub async fn read_blob_at_ref(
    worktree_id: WorktreeId,
    path: String,
    reference: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();
    let workspace_root = state
        .workspaces
        .get(&wt.workspace_id)
        .map(|e| e.value().root.clone())
        .ok_or_else(|| AppError::Unknown("workspace missing".into()))?;
    Ok(crate::worktree::git_ops::show_blob(&workspace_root, &reference, &path)
        .await?
        .unwrap_or_default())
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
pub async fn list_files(
    worktree_id: WorktreeId,
    show_ignored: Option<bool>,
    state: State<'_, AppState>,
) -> AppResult<Vec<String>> {
    fs_api::list_files(worktree_id, show_ignored.unwrap_or(false), &state).await
}

#[tauri::command]
pub async fn get_diff(
    worktree_id: WorktreeId,
    mode: Option<DiffMode>,
    state: State<'_, AppState>,
) -> AppResult<DiffSet> {
    let mode = mode.unwrap_or_default();
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();
    let ws = state
        .workspaces
        .get(&wt.workspace_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {}", wt.workspace_id)))?
        .clone();

    let base = crate::worktree::git_ops::effective_base(
        &ws.default_branch,
        ws.base_ref_override.as_deref(),
    );
    let anchor = match mode {
        DiffMode::Branch => crate::worktree::git_ops::live_branch_anchor(
            &wt.path,
            &ws.default_branch,
            &base,
            &wt.branch,
            &wt.base_ref,
        ),
        DiffMode::Uncommitted => crate::worktree::git_ops::rev_parse(&wt.path, "HEAD")
            .await
            .unwrap_or_else(|_| wt.head.clone()),
    };

    // Branch view uses the cached diff written by `fs_watch` so a fresh tab
    // open is a hot path — but only when the cache was built against the same
    // anchor we'd compute now. If the user rebased externally and `fs_watch`
    // hasn't fired since, the cache's `base_ref` won't match `anchor` and we
    // fall through to recompute. Uncommitted view never caches — its anchor
    // (HEAD) can move between fs events (e.g. agent commits).
    if matches!(mode, DiffMode::Branch) {
        if let Some(cached) = state.diffs.get(&worktree_id) {
            if cached.base_ref == anchor {
                return Ok(cached.clone());
            }
        }
    }

    let wt_path = wt.path.clone();
    let wt_id = wt.id;
    let computed = tokio::task::spawn_blocking(move || {
        diff::compute::compute(wt_id, &wt_path, &anchor)
    })
    .await
    .map_err(|e| AppError::Unknown(format!("diff task join: {e}")))??;

    if matches!(mode, DiffMode::Branch) {
        state.diffs.insert(worktree_id, computed.clone());
    }
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
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();
    let ws = state
        .workspaces
        .get(&wt.workspace_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {}", wt.workspace_id)))?
        .clone();

    // Resolution layers the workspace-scoped override (if any) on top
    // of the global LspConfig, expands `${WORKTREE_PATH}` /
    // `${WORKTREE_NAME}`, and defaults `path_mapping.host_root` to
    // the active worktree path. With no override, identical to
    // loading the global config.
    let config = lsp::overrides::resolve(&app, &ws.root, &wt.path, &language_id)
        .await?
        .ok_or_else(|| {
            AppError::Unknown(format!("lsp language not enabled: {language_id}"))
        })?;

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
pub async fn lsp_resolve_command(command: String) -> AppResult<Option<String>> {
    lsp::config::resolve_command(&command).await
}

/// Sweep the Rust LSP registry by `worktree_id`, killing every
/// server attached to that worktree regardless of language. Used by
/// the renderer's "Restart language servers" command — important
/// because that path can't rely on per-server `serverId`s the way
/// `lsp_kill` does (the JS `sessions` map can drift out of sync
/// with the Rust registry across HMR / restart races, leaving
/// `lsp_kill` a no-op while the registry holds a still-alive
/// server that the next `ensureSession` then attaches to). This
/// IPC is the registry-of-truth equivalent of the Settings toggle's
/// `kill_for_language` path.
#[tauri::command]
pub async fn lsp_kill_for_worktree(
    worktree_id: WorktreeId,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let workspace_id = state
        .worktrees
        .get(&worktree_id)
        .map(|e| e.value().workspace_id);
    lsp::supervisor::kill_for_worktree(&state.lsp, worktree_id);
    if let Some(ws_id) = workspace_id {
        let _ = app.emit(&events::lsp_servers_changed(ws_id), ());
    }
    Ok(())
}

/// Resolve the post-create hook steps for a worktree. Looks up the
/// owning workspace, walks the in-repo + user-level config layers,
/// and substitutes `${WORKTREE_PATH}`, `${WORKTREE_NAME}`,
/// `${BASE_BRANCH}` in command/args/env so the renderer can stitch
/// together a script string with literal values. Returns an empty
/// list when no config is present at either layer.
#[tauri::command]
pub async fn worktree_setup_steps(
    worktree_id: WorktreeId,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Vec<worktree::setup::HookStep>> {
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();
    let ws = state
        .workspaces
        .get(&wt.workspace_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {}", wt.workspace_id)))?
        .clone();
    let steps =
        worktree::setup::resolve(&app, &ws.root, worktree::setup::Hook::OnCreate).await?;
    let name = wt
        .path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(worktree::setup::apply_templates(
        steps,
        &wt.path,
        &name,
        &wt.base_ref,
    ))
}

/// Best-effort marker write so a future "re-run setup" command can
/// know what's already been done. Failure is non-fatal — the renderer
/// just logs and continues.
#[tauri::command]
pub async fn worktree_mark_setup_ran(
    worktree_id: WorktreeId,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let wt = state
        .worktrees
        .get(&worktree_id)
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))?
        .clone();
    worktree::setup::mark_ran(&wt.path).await
}

/// One of the system files we let the renderer surface in-app.
/// `kind` is a flat string so the IPC stays JSON-friendly; the
/// renderer just passes one of these literals.
fn resolve_app_file(
    app: &AppHandle,
    kind: &str,
    file: Option<&str>,
) -> AppResult<PathBuf> {
    match kind {
        "log" => {
            let dir = log_dir().ok_or_else(|| AppError::Unknown("HOME not set".into()))?;
            match file {
                Some(name) => {
                    if name.contains('/') || name.contains("..") {
                        return Err(AppError::Unknown(format!(
                            "log file name has path components: {name}"
                        )));
                    }
                    Ok(dir.join(name))
                }
                None => latest_log(&dir),
            }
        }
        "treehouseConfig" => crate::user_config::config_path(app),
        _ => Err(AppError::Unknown(format!("unknown app file kind: {kind}"))),
    }
}

fn log_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Logs/com.treehouse.app"))
}

/// Pick the alphabetically-latest `treehouse.log*` in `dir`.
/// `tracing-appender` names files `treehouse.log.YYYY-MM-DD`, so a
/// lex sort puts the newest at the end.
fn latest_log(dir: &std::path::Path) -> AppResult<PathBuf> {
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return Err(AppError::Unknown(format!("no logs at {}", dir.display()))),
    };
    let mut latest: Option<String> = None;
    for entry in read.flatten() {
        let name = entry.file_name();
        let name_s = match name.to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        if !name_s.starts_with("treehouse.log") {
            continue;
        }
        if latest.as_deref().map(|l| name_s.as_str() > l).unwrap_or(true) {
            latest = Some(name_s);
        }
    }
    match latest {
        Some(name) => Ok(dir.join(name)),
        None => Err(AppError::Unknown(format!(
            "no treehouse.log files in {}",
            dir.display()
        ))),
    }
}

#[derive(Debug, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppFileContent {
    pub path: String,
    pub content: String,
}

/// Read an app-managed system file so the renderer can show it in
/// an in-app Monaco viewer instead of having to shell out to a
/// separate editor / terminal.
///
/// `kind` discriminates which file:
/// - `"log"` — most recent `treehouse.log*` (or specific one via `file`)
/// - `"treehouseConfig"` — unified user config (`treehouse.toml`)
///
/// Missing files are surfaced as an empty-content response with the
/// path populated, so the renderer can show "no content yet at <path>"
/// rather than erroring.
#[tauri::command]
pub async fn read_app_text_file(
    kind: String,
    file: Option<String>,
    app: AppHandle,
) -> AppResult<AppFileContent> {
    let path = resolve_app_file(&app, &kind, file.as_deref())?;
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(AppError::Io(format!("read {}: {e}", path.display()))),
    };
    Ok(AppFileContent {
        path: path.to_string_lossy().to_string(),
        content,
    })
}

/// Write an app-managed system file from the in-app Monaco viewer.
/// Only `kind == "treehouseConfig"` is writable — logs are append-only
/// from `tracing-appender` and editing them in-app would race with the
/// next emit. Creates the parent directory if missing so a first-time
/// save after a fresh install doesn't fail on a non-existent
/// `Application Support/com.treehouse.app/`.
#[tauri::command]
pub async fn write_app_text_file(
    kind: String,
    content: String,
    app: AppHandle,
) -> AppResult<()> {
    let path = match kind.as_str() {
        "treehouseConfig" => crate::user_config::config_path(&app)?,
        "log" => {
            return Err(AppError::Unknown(
                "log files are read-only (tracing-appender owns the writes)".into(),
            ))
        }
        other => return Err(AppError::Unknown(format!("unknown app file kind: {other}"))),
    };
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| {
            AppError::Io(format!("mkdir -p {}: {e}", dir.display()))
        })?;
    }
    tokio::fs::write(&path, content.as_bytes())
        .await
        .map_err(|e| AppError::Io(format!("write {}: {e}", path.display())))?;
    Ok(())
}

/// List the daily-rotated log files in `~/Library/Logs/com.treehouse.app/`,
/// newest first. Empty list when the directory hasn't been created
/// yet (no logs ever written).
#[tauri::command]
pub async fn list_log_files() -> AppResult<Vec<String>> {
    let dir = match log_dir() {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(format!("read {}: {e}", dir.display()))),
    };
    let mut names = Vec::new();
    while let Some(entry) = rd.next_entry().await? {
        if let Ok(name) = entry.file_name().into_string() {
            if name.starts_with("treehouse.log") {
                names.push(name);
            }
        }
    }
    names.sort_by(|a, b| b.cmp(a));
    Ok(names)
}

/// Open the app's log directory in Finder so the user can grab the
/// daily-rotated `treehouse.log` files. The directory is created on
/// startup by `tracing-appender`, but if for some reason it doesn't
/// exist yet (e.g. file logging fell through silently because $HOME
/// wasn't set) we surface that as an error rather than spawning
/// `open` against a missing path.
#[tauri::command]
pub async fn open_logs_folder() -> AppResult<()> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| AppError::Unknown("HOME not set".into()))?;
    let dir = std::path::PathBuf::from(home).join("Library/Logs/com.treehouse.app");
    if !dir.exists() {
        return Err(AppError::Unknown(format!(
            "log directory not found: {}",
            dir.display()
        )));
    }
    tokio::process::Command::new("open")
        .arg(&dir)
        .spawn()
        .map_err(|e| AppError::Unknown(format!("open {}: {e}", dir.display())))?;
    Ok(())
}

/// Reload `treehouse.toml`. Used by the "Settings: Reload" command
/// after the user edits the file out-of-app. Re-reads the agent
/// status patterns into the registry — reader threads share an
/// `Arc<RwLock<AgentPatterns>>` and pick up the new list on the
/// next chunk, so no respawn is needed.
///
/// LSP overrides, custom languages, and worktree hooks are read
/// fresh on each lookup, so they don't need an explicit reload —
/// the next file open / worktree create / language toggle picks up
/// the new values automatically.
#[tauri::command]
pub async fn treehouse_config_reload(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let p = agent::patterns::load(&app).await?;
    state.agents.set_patterns(p);
    Ok(())
}

/// Ensure `treehouse.toml` exists (seeded with a header comment +
/// schema reference on first call) and open it in the user's default
/// editor. macOS only — `open` selects the right editor based on the
/// user's default for `.toml`.
#[tauri::command]
pub async fn treehouse_config_open_file(app: AppHandle) -> AppResult<()> {
    let path = crate::user_config::ensure_file(&app).await?;
    tokio::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| AppError::Unknown(format!("open {}: {e}", path.display())))?;
    Ok(())
}

/// Start the file watcher for a worktree and kick off an initial diff compute.
/// Both are best-effort: failures are logged but don't block the caller.
pub(crate) fn prime_worktree_watch(app: &AppHandle, wt: &Worktree) {
    let app_clone = app.clone();
    let worktree_id = wt.id;
    let worktree_path = wt.path.clone();
    let ws = app
        .state::<AppState>()
        .workspaces
        .get(&wt.workspace_id)
        .map(|e| e.value().clone());
    let base_ref = match ws {
        Some(ws) => crate::worktree::git_ops::live_branch_anchor(
            &worktree_path,
            &ws.default_branch,
            &crate::worktree::git_ops::effective_base(
                &ws.default_branch,
                ws.base_ref_override.as_deref(),
            ),
            &wt.branch,
            &wt.base_ref,
        ),
        None => wt.base_ref.clone(),
    };

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
