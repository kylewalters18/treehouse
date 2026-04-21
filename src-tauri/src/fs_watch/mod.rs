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
use crate::util::ids::WorktreeId;

const DEBOUNCE_MS: u64 = 150;
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

            tracing::debug!(count = events.len(), worktree_id = %worktree_id, "fs debounce batch");

            // Filter to events with at least one non-ignored path we care about.
            let mut saw_relevant = false;
            for ev in &events {
                if !interesting_kind(&ev.event.kind) {
                    continue;
                }
                for p in &ev.event.paths {
                    let ignored = is_ignored(&ignore, &root, p);
                    tracing::debug!(path = %p.display(), ignored, kind = ?ev.event.kind, "fs event");
                    if !ignored {
                        saw_relevant = true;
                    }
                }
            }
            if !saw_relevant {
                tracing::debug!(worktree_id = %worktree_id, "fs batch: nothing relevant");
                return;
            }

            // Recompute + cache + emit.
            tracing::debug!(worktree_id = %worktree_id, "fs batch: recomputing diff");
            let state = app_for_events.state::<AppState>();
            let base_current = state
                .worktrees
                .get(&worktree_id)
                .map(|e| e.value().base_ref.clone());
            let Some(base_current) = base_current else {
                tracing::warn!(%worktree_id, "worktree vanished during debounce");
                return;
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
        let path = wt.path.clone();
        let base_ref = wt.base_ref.clone();
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
