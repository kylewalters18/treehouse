//! Per-workspace LSP overrides. Layered on top of the language's
//! `LspConfig` (built-in or user-custom) at session-spawn time, so
//! e.g. clangd can run inside a devcontainer for one repo without
//! changing how every other workspace's LSPs work. Applies to every
//! worktree of the matching workspace; templates expand per-worktree
//! at resolve time so a single block can cover an unbounded number
//! of worktrees.
//!
//! Persisted as a section of `treehouse.toml` under
//! `[[lsp.override]]`. Schema:
//!
//! ```toml
//! [[lsp.override]]
//! workspace = "/Users/kyle/Code/repo"
//! language = "cpp"
//! command = "docker"
//! args = ["exec", "-i", "treehouse-clangd-${WORKTREE_NAME}", "clangd"]
//! [lsp.override.pathMapping]
//! remoteRoot = "/workspaces/repo"
//! ```
//!
//! Any field that's `None` falls through to the global `LspConfig`
//! for the same `language`. `${WORKTREE_PATH}` and `${WORKTREE_NAME}`
//! are expanded to the active worktree's absolute host path /
//! basename at resolve time.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use ts_rs::TS;

use crate::util::errors::AppResult;

use super::{LspConfig, PathMapping};

/// Partial language config. Anything `None` inherits from the global
/// `LspConfig` for the same language.
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LspOverride {
    /// Absolute host path of the workspace this override applies to
    /// (the main clone — not a worktree). Applies to every worktree
    /// of that workspace. Canonicalized at compare time so symlink /
    /// trailing-slash variants still match.
    pub workspace: String,
    /// Matches `LspConfig::id` (e.g. `"cpp"`).
    pub language: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "path_mapping"
    )]
    pub path_mapping: Option<PathMapping>,
}

/// Find an override matching `(workspace_path, language_id)`. Both
/// sides of the workspace comparison are canonicalized so symlink-
/// resolved / trailing-slashed inputs collide cleanly.
pub async fn find_for(
    app: &AppHandle,
    workspace_path: &Path,
    language_id: &str,
) -> AppResult<Option<LspOverride>> {
    let cfg = crate::user_config::load(app).await?;
    let target = canonicalize(workspace_path);
    Ok(cfg.lsp.overrides.into_iter().find(|o| {
        o.language == language_id && canonicalize(Path::new(&o.workspace)) == target
    }))
}

/// Best-effort canonicalization. If the path doesn't exist (rare for
/// the runtime worktree, more common for an override pointing at a
/// removed worktree), fall back to a normalized string so we still
/// match exact-string overrides for not-yet-created paths.
fn canonicalize(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| {
        let s = p.to_string_lossy();
        let trimmed = s.trim_end_matches('/');
        PathBuf::from(trimmed)
    })
}

/// Resolve the effective `LspConfig` for a `(workspace, worktree,
/// language)` triple: load the language definition from
/// built-ins/customs, layer the matching workspace-scoped override on
/// top, expand `${WORKTREE_PATH}` and `${WORKTREE_NAME}` in
/// command/args/env/path_mapping, and default `path_mapping.host_root`
/// to the active worktree path when unset.
///
/// Returns `Ok(None)` when the language isn't enabled in
/// `Settings::enabled_lsp_languages` — preserves the existing "no LSP
/// if not enabled" behavior. Overrides do NOT enable a disabled
/// language; that's deliberate, so a stale config can't keep
/// resurrecting a server the user explicitly turned off.
pub async fn resolve(
    app: &AppHandle,
    workspace_root: &Path,
    worktree_path: &Path,
    language_id: &str,
) -> AppResult<Option<LspConfig>> {
    let settings = crate::storage::load_settings(app).await.unwrap_or_default();
    if !settings
        .enabled_lsp_languages
        .iter()
        .any(|s| s == language_id)
    {
        return Ok(None);
    }

    let configs = super::config::list(app).await?;
    let mut config = match configs.into_iter().find(|c| c.id == language_id) {
        Some(c) => c,
        None => return Ok(None),
    };

    if let Some(o) = find_for(app, workspace_root, language_id).await? {
        if let Some(cmd) = o.command {
            config.command = cmd;
        }
        if let Some(args) = o.args {
            config.args = args;
        }
        if let Some(env) = o.env {
            // Override fully replaces env rather than merging keys —
            // simpler to reason about, matches the rest of the layering.
            config.env = env;
        }
        if let Some(pm) = o.path_mapping {
            config.path_mapping = Some(pm);
        }
    }

    let worktree_path_str = worktree_path.to_string_lossy().to_string();
    let worktree_name = worktree_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let sub = |s: &str| -> String {
        s.replace("${WORKTREE_PATH}", &worktree_path_str)
            .replace("${WORKTREE_NAME}", &worktree_name)
    };
    config.command = sub(&config.command);
    config.args = config.args.into_iter().map(|a| sub(&a)).collect();
    config.env = config
        .env
        .into_iter()
        .map(|(k, v)| (k, sub(&v)))
        .collect();

    if let Some(pm) = config.path_mapping.as_mut() {
        pm.remote_root = sub(&pm.remote_root);
        match pm.host_root.as_mut() {
            Some(h) => *h = sub(h),
            None => pm.host_root = Some(worktree_path_str.clone()),
        }
    }

    Ok(Some(config))
}
