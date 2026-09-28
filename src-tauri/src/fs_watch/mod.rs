//! Per-worktree file watching. Each worktree gets its own debounced
//! `RecommendedWatcher` (via `notify-debouncer-full`). Events are filtered
//! through a gitignore-aware matcher plus a built-in ignore list (.git,
//! node_modules, target, dist, .DS_Store). On any flush with a surviving path,
//! we trigger a full diff recompute and emit `diff://{worktree_id}/updated`.

use std::any::Any;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify_debouncer_full::notify::{EventKind, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use tauri::{AppHandle, Emitter, Manager};

use crate::diff;
use crate::state::AppState;
use crate::util::errors::{AppError, AppResult};
use crate::util::ids::{WorkspaceId, WorktreeId};

const DEBOUNCE_MS: u64 = 150;
/// Worktree create/remove is a coarse event — a longer debounce than the
/// per-file watcher coalesces the burst `git worktree add` writes into one
/// reconcile pass.
const WORKSPACE_DEBOUNCE_MS: u64 = 300;
const BUILTIN_IGNORES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".DS_Store",
    ".next",
    ".turbo",
    ".cache",
];

/// Keeping the Debouncer alive keeps the watcher thread alive. The concrete
/// type is irrelevant to us after construction; we only need it to live.
pub struct WatcherHandle {
    _debouncer: Box<dyn Any + Send + Sync>,
}

#[derive(Default)]
pub struct WatchRegistry {
    inner: DashMap<WorktreeId, WatcherHandle>,
}

impl WatchRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_watching(&self, id: &WorktreeId) -> bool {
        self.inner.contains_key(id)
    }

    pub fn stop(&self, id: &WorktreeId) {
        self.inner.remove(id);
    }
}

/// Watchers on each workspace's `<repo>__worktrees/` root, one per open
/// workspace. Separate from the per-worktree `WatchRegistry` — these fire
/// on worktree dirs appearing/disappearing, not file churn inside them.
#[derive(Default)]
pub struct WorkspaceWatchRegistry {
    inner: DashMap<WorkspaceId, WatcherHandle>,
}

impl WorkspaceWatchRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_watching(&self, id: &WorkspaceId) -> bool {
        self.inner.contains_key(id)
    }

    pub fn stop(&self, id: &WorkspaceId) {
        self.inner.remove(id);
    }
}

/// Start watching `worktree_path`. The watcher reads the current `base_ref`
/// from `AppState` on each debounce flush, so later mutations (e.g. after
/// sync or merge-back advance it) take effect for subsequent recomputes.
/// Safe to call twice for the same id — the second call replaces the first.
pub fn start(
    app: AppHandle,
    worktree_id: WorktreeId,
    worktree_path: PathBuf,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let registry = state.watchers.clone();

    if registry.is_watching(&worktree_id) {
        registry.stop(&worktree_id);
    }

    let ignore = Arc::new(build_ignore(&worktree_path)?);
    let app_for_events = app.clone();
    let root = worktree_path.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        None,
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(e) => e,
                Err(errs) => {
                    for err in errs {
                        tracing::warn!(?err, "watch error");
                    }
                    return;
                }
            };

            tracing::trace!(count = events.len(), worktree_id = %worktree_id, "fs debounce batch");

            // Filter to events with at least one non-ignored path we care about.
            let mut saw_relevant = false;
            for ev in &events {
                if !interesting_kind(&ev.event.kind) {
                    continue;
                }
                for p in &ev.event.paths {
                    // Ignored paths (e.g. a cargo build churning `target/`)
                    // can be thousands per batch — don't log them.
                    if !is_ignored(&ignore, &root, p) {
                        tracing::trace!(path = %p.display(), kind = ?ev.event.kind, "fs event");
                        saw_relevant = true;
                    }
                }
            }
            if !saw_relevant {
                tracing::trace!(worktree_id = %worktree_id, "fs batch: nothing relevant");
                return;
            }

            // Recompute + cache + emit.
            tracing::debug!(worktree_id = %worktree_id, "fs batch: recomputing diff");
            let state = app_for_events.state::<AppState>();
            let wt_snapshot = state
                .worktrees
                .get(&worktree_id)
                .map(|e| e.value().clone());
            let Some(wt) = wt_snapshot else {
                tracing::warn!(%worktree_id, "worktree vanished during debounce");
                return;
            };
            let ws = state
                .workspaces
                .get(&wt.workspace_id)
                .map(|e| e.value().clone());
            let base_current = match ws {
                Some(ws) => crate::worktree::git_ops::live_branch_anchor(
                    &wt.path,
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
            let diff_set = match diff::compute::compute(worktree_id, &root, &base_current) {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!(?e, worktree_id = %worktree_id, "diff compute failed");
                    return;
                }
            };
            state.diffs.insert(worktree_id, diff_set.clone());
            match app_for_events.emit(&crate::ipc::events::diff_updated(worktree_id), &diff_set) {
                Ok(()) => tracing::debug!(
                    worktree_id = %worktree_id,
                    files = diff_set.files.len(),
                    "emitted diff_updated"
                ),
                Err(e) => tracing::warn!(?e, "emit diff_updated failed"),
            }
            // Same event batch likely moved ahead/behind/dirty too. Fire
            // the git-status recompute so the next activity poll reflects
            // the new state — no inline git subprocesses on the poll path.
            crate::worktree::status::spawn_recompute(&app_for_events, worktree_id);
        },
    )
    .map_err(|e| AppError::Unknown(format!("watcher init: {e}")))?;

    debouncer
        .watcher()
        .watch(&worktree_path, RecursiveMode::Recursive)
        .map_err(|e| AppError::Unknown(format!("watcher watch: {e}")))?;

    registry.inner.insert(
        worktree_id,
        WatcherHandle {
            _debouncer: Box::new(debouncer),
        },
    );
    tracing::info!(id = %worktree_id, path = %worktree_path.display(), "watching worktree");
    Ok(())
}

pub fn stop(app: &AppHandle, id: &WorktreeId) {
    let state = app.state::<AppState>();
    state.watchers.stop(id);
}

/// Watch a workspace's `<repo>__worktrees/` root for worktrees created or
/// removed outside treehouse (e.g. a script running `git worktree add`).
/// On any direct child appearing/disappearing we re-run `reconcile`, prime
/// watchers for newly-adopted worktrees, and fan out `worktrees-changed`
/// so the sidebar refreshes. `NonRecursive`: file churn *inside* a worktree
/// is handled by that worktree's own watcher — here we only care about the
/// top-level dirs themselves. Also starts the git-dir ref watcher (see
/// `start_git_dir`) under the same handle. Safe to call twice for the same id — the
/// second call replaces the first. Best-effort: a watch-setup failure logs
/// and returns Ok so it never blocks `open_workspace`.
pub fn start_workspace(
    app: AppHandle,
    workspace_id: WorkspaceId,
    repo_root: PathBuf,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let registry = state.workspace_watchers.clone();

    if registry.is_watching(&workspace_id) {
        registry.stop(&workspace_id);
    }

    let root = crate::worktree::git_ops::worktrees_root_for(&repo_root);
    // The dir may not exist yet (workspace has no worktrees). Create it so
    // there's something to watch — an empty sibling dir is harmless, and
    // `git worktree add` would create it anyway.
    if let Err(e) = std::fs::create_dir_all(&root) {
        tracing::warn!(?e, path = %root.display(), "could not create worktrees root to watch");
        return Ok(());
    }

    let app_for_events = app.clone();
    let watch_root = root.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(WORKSPACE_DEBOUNCE_MS),
        None,
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(e) => e,
                Err(errs) => {
                    for err in errs {
                        tracing::warn!(?err, "workspace watch error");
                    }
                    return;
                }
            };
            // Only react to a create/remove touching something under the
            // root. Reconcile is the source of truth for *what* changed —
            // this is just the trigger, and it no-ops if nothing did.
            let relevant = events.iter().any(|ev| {
                matches!(ev.event.kind, EventKind::Create(_) | EventKind::Remove(_))
                    && ev.event.paths.iter().any(|p| p.starts_with(&watch_root))
            });
            if !relevant {
                return;
            }

            let app = app_for_events.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<AppState>();
                let delta = match crate::worktree::reconcile(workspace_id, &state).await {
                    Ok(d) => d,
                    Err(e) => {
                        tracing::warn!(?e, %workspace_id, "autodiscover reconcile failed");
                        return;
                    }
                };
                if delta.added.is_empty() && delta.removed.is_empty() {
                    return; // on-disk set already matched state
                }
                // Start watchers + compute the initial diff for each
                // newly-adopted worktree, mirroring `open_workspace`.
                for id in &delta.added {
                    if let Some(wt) = state.worktrees.get(id).map(|e| e.value().clone()) {
                        crate::ipc::commands::prime_worktree_watch(&app, &wt);
                    }
                }
                if !delta.added.is_empty() {
                    crate::worktree::status::recompute_all_for_workspace(&app, workspace_id)
                        .await;
                }
                tracing::info!(
                    %workspace_id,
                    added = delta.added.len(),
                    removed = delta.removed.len(),
                    "autodiscovered worktree change",
                );
                let _ = app.emit(&crate::ipc::events::worktrees_changed(workspace_id), ());
                // Removals tore down LSP servers; nudge the sidebar's LSP view too.
                if !delta.removed.is_empty() {
                    let _ = app.emit(&crate::ipc::events::lsp_servers_changed(workspace_id), ());
                }
            });
        },
    )
    .map_err(|e| AppError::Unknown(format!("workspace watcher init: {e}")))?;

    debouncer
        .watcher()
        .watch(&root, RecursiveMode::NonRecursive)
        .map_err(|e| AppError::Unknown(format!("workspace watcher watch: {e}")))?;

    tracing::info!(id = %workspace_id, path = %root.display(), "watching worktrees root");

    // Keep both debouncers alive under the one workspace handle. A git-dir
    // watch failure is non-fatal: status just falls back to the file-event
    // and explicit sync/merge triggers.
    let git_debouncer = match start_git_dir(app.clone(), workspace_id, &repo_root) {
        Ok(d) => Some(d),
        Err(e) => {
            tracing::warn!(?e, %workspace_id, "git dir watch failed");
            None
        }
    };

    registry.inner.insert(
        workspace_id,
        WatcherHandle {
            _debouncer: Box::new((debouncer, git_debouncer)),
        },
    );
    Ok(())
}

/// Watch the repo's common git dir for ref movement: commits, resets,
/// fetches, and pulls/merges on the default branch. None of these touch a
/// linked worktree's files (its `.git` is a pointer file, and the per-worktree
/// watcher ignores `.git` anyway), so without this ahead/behind goes stale
/// until the next unrelated file edit. Any ref change recomputes status for
/// every worktree in the workspace — one ref can move ahead/behind for all
/// of them, and `merged` checks are memoized by SHA pair so it's cheap.
fn start_git_dir(
    app: AppHandle,
    workspace_id: WorkspaceId,
    repo_root: &Path,
) -> AppResult<Box<dyn Any + Send + Sync>> {
    let git_dir = common_git_dir(repo_root)?;
    // FSEvents reports canonical paths; canonicalize so strip_prefix works
    // when the repo path goes through a symlink (e.g. /tmp → /private/tmp).
    let git_dir = git_dir.canonicalize().unwrap_or(git_dir);
    let watch_root = git_dir.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(WORKSPACE_DEBOUNCE_MS),
        None,
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(e) => e,
                Err(errs) => {
                    for err in errs {
                        tracing::warn!(?err, "git dir watch error");
                    }
                    return;
                }
            };
            let relevant = events.iter().any(|ev| {
                interesting_kind(&ev.event.kind)
                    && ev.event.paths.iter().any(|p| {
                        p.strip_prefix(&watch_root)
                            .map(is_ref_path)
                            .unwrap_or(false)
                    })
            });
            if !relevant {
                return;
            }
            tracing::debug!(%workspace_id, "git refs moved: recomputing worktree status");
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::worktree::status::recompute_all_for_workspace(&app, workspace_id).await;
            });
        },
    )
    .map_err(|e| AppError::Unknown(format!("git dir watcher init: {e}")))?;

    debouncer
        .watcher()
        .watch(&git_dir, RecursiveMode::Recursive)
        .map_err(|e| AppError::Unknown(format!("git dir watcher watch: {e}")))?;

    tracing::info!(id = %workspace_id, path = %git_dir.display(), "watching git refs");
    Ok(Box::new(debouncer))
}

/// The repo's shared git dir. `repo.path()` is the per-checkout git dir;
/// for a linked worktree it holds a `commondir` file (usually `../..`)
/// pointing at the shared one. git2 0.19 doesn't expose `commondir()`.
fn common_git_dir(repo_root: &Path) -> AppResult<PathBuf> {
    let repo = git2::Repository::open(repo_root)
        .map_err(|e| AppError::Unknown(format!("open repo: {e}")))?;
    let git_dir = repo.path().to_path_buf();
    match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(rel) => Ok(git_dir.join(rel.trim())),
        Err(_) => Ok(git_dir),
    }
}

/// Does a path (relative to the common git dir) record a ref moving? Loose
/// refs, `packed-refs`, the main and per-worktree `HEAD`s, and reflogs (a
/// backstop — every ref update appends one). Lock files are skipped: git
/// writes `<ref>.lock` then renames it into place, and the rename lands on
/// the real path. Everything else (objects, index, config) is ignored, which
/// also keeps our own recompute's git calls from re-triggering this watcher.
fn is_ref_path(rel: &Path) -> bool {
    if rel.extension().is_some_and(|e| e == "lock") {
        return false;
    }
    let mut parts = rel.components().map(|c| c.as_os_str());
    match parts.next().and_then(|s| s.to_str()) {
        Some("refs") | Some("logs") => true,
        Some("packed-refs") | Some("HEAD") => parts.next().is_none(),
        // worktrees/<slug>/HEAD — a detached-HEAD commit in a linked worktree.
        Some("worktrees") => {
            let _slug = parts.next();
            parts.next().is_some_and(|s| s == "HEAD") && parts.next().is_none()
        }
        _ => false,
    }
}

pub fn stop_workspace(app: &AppHandle, id: &WorkspaceId) {
    let state = app.state::<AppState>();
    state.workspace_watchers.stop(id);
}

/// Recompute the cached DiffSet for a worktree and emit `diff_updated`.
/// Reads the latest `base_ref` from state — call this after mutating
/// `base_ref` (sync, merge-back) so the frontend sees the fresh view even
/// though no filesystem event fired.
pub fn recompute_and_emit(app: &AppHandle, worktree_id: WorktreeId) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app_clone.state::<AppState>();
        let Some(wt) = state
            .worktrees
            .get(&worktree_id)
            .map(|e| e.value().clone())
        else {
            return;
        };
        let ws = state
            .workspaces
            .get(&wt.workspace_id)
            .map(|e| e.value().clone());
        let path = wt.path.clone();
        let base_ref = match ws {
            Some(ws) => crate::worktree::git_ops::live_branch_anchor(
                &path,
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
        let res = tokio::task::spawn_blocking(move || {
            diff::compute::compute(worktree_id, &path, &base_ref)
        })
        .await;
        match res {
            Ok(Ok(d)) => {
                state.diffs.insert(worktree_id, d.clone());
                let _ = app_clone.emit(&crate::ipc::events::diff_updated(worktree_id), &d);
            }
            Ok(Err(e)) => tracing::warn!(?e, %worktree_id, "recompute failed"),
            Err(e) => tracing::warn!(?e, %worktree_id, "recompute task join failed"),
        }
    });
}

fn interesting_kind(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn build_ignore(root: &Path) -> AppResult<Gitignore> {
    let mut builder = GitignoreBuilder::new(root);
    // Prefer the worktree's own .gitignore first, then our built-ins. Missing
    // files are silently skipped by the add* functions.
    let gi_path = root.join(".gitignore");
    let _ = builder.add(gi_path);
    for pat in BUILTIN_IGNORES {
        // Anchor-less patterns match any path segment; that's what we want.
        let _ = builder.add_line(None, pat);
    }
    builder
        .build()
        .map_err(|e| AppError::Unknown(format!("gitignore build: {e}")))
}

fn is_ignored(gi: &Gitignore, root: &Path, path: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    gi.matched_path_or_any_parents(rel, rel.is_dir())
        .is_ignore()
}

#[cfg(test)]
mod tests {
    use super::is_ref_path;
    use std::path::Path;

    #[test]
    fn ref_paths_trigger() {
        for p in [
            "refs/heads/feature",
            "refs/remotes/origin/main",
            "packed-refs",
            "HEAD",
            "logs/refs/heads/main",
            "worktrees/my-slug/HEAD",
        ] {
            assert!(is_ref_path(Path::new(p)), "{p} should trigger");
        }
    }

    #[test]
    fn non_ref_paths_ignored() {
        for p in [
            "refs/heads/feature.lock",
            "packed-refs.lock",
            "HEAD.lock",
            "index",
            "objects/ab/cdef",
            "config",
            "worktrees/my-slug/index",
            "worktrees/my-slug/HEAD.lock",
            "FETCH_HEAD",
        ] {
            assert!(!is_ref_path(Path::new(p)), "{p} should be ignored");
        }
    }
}
