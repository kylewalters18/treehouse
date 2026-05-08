//! Per-worktree LSP overrides. Layered on top of the global
//! `languages.toml` at session-spawn time, so e.g. clangd can run
//! inside a devcontainer for one worktree without changing how every
//! other worktree's LSPs work.
//!
//! Persisted as TOML at `<app_config>/worktree_lsp.toml`. Schema:
//!
//! ```toml
//! [[override]]
//! worktree = "/Users/kyle/Code/repo__worktrees/feature-x"
//! language = "cpp"
//! command = "devcontainer"
//! args = ["exec", "--workspace-folder", "${WORKTREE_PATH}", "clangd"]
//! [override.path_mapping]
//! remote_root = "/workspaces/repo"
//! ```
//!
//! Any field that's `None` falls through to the global `LspConfig` for
//! the same `language`. `${WORKTREE_PATH}` is expanded to the active
//! worktree's absolute host path at resolve time.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use ts_rs::TS;

use crate::util::errors::{AppError, AppResult};

use super::{LspConfig, PathMapping};

const FILE: &str = "worktree_lsp.toml";

/// Header comment seeded into a fresh `worktree_lsp.toml` so the user
/// has a working example to start from.
const SEED_HEADER: &str = "\
# treehouse — per-worktree LSP overrides
#
# Layered on top of `languages.toml` at session-spawn time. Any field
# you set here wins; anything you omit inherits from the global config.
#
# Each entry needs `worktree` (the absolute host path of the worktree)
# and `language` (matches the `id` in languages.toml). `${WORKTREE_PATH}`
# in command/args/env values is expanded to the worktree's absolute
# host path at runtime.
#
# Field names use camelCase to match `languages.toml`:
# `pathMapping`, `remoteRoot`, `hostRoot`. snake_case (`path_mapping`,
# `remote_root`, `host_root`) is also accepted as an alias.
#
# `pathMapping` installs a JSON-RPC middleware that swaps file:// URIs
# between host and the LSP's view of the filesystem — useful for
# containerized servers. `hostRoot` defaults to the worktree path.
#
# Example: clangd inside a devcontainer.
#
# [[override]]
# worktree = \"/absolute/path/to/this/worktree\"
# language = \"cpp\"
# command = \"devcontainer\"
# args = [\"exec\", \"--workspace-folder\", \"${WORKTREE_PATH}\", \"clangd\"]
# [override.pathMapping]
# remoteRoot = \"/workspaces/repo\"
";

/// Partial language config. Anything `None` inherits from the global
/// `LspConfig` for the same language.
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LspOverride {
    /// Absolute host path of the worktree this override applies to.
    /// Canonicalized at compare time so `~`/symlink/trailing-slash
    /// variants still match.
    pub worktree: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct OverridesFile {
    #[serde(rename = "override", default)]
    overrides: Vec<LspOverride>,
}

pub fn config_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Unknown(format!("config dir: {e}")))?;
    Ok(dir.join(FILE))
}

/// Load all overrides. Returns an empty list if the file doesn't exist
/// — overrides are entirely opt-in, and silently no-op'ing keeps the
/// default behavior identical to the pre-feature state.
pub async fn list(app: &AppHandle) -> AppResult<Vec<LspOverride>> {
    let path = config_path(app)?;
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => {
            let file: OverridesFile = toml::from_str(&s)
                .map_err(|e| AppError::Unknown(format!("parse worktree_lsp.toml: {e}")))?;
            Ok(file.overrides)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(AppError::Io(format!("read {}: {e}", path.display()))),
    }
}

/// Find an override matching `(worktree_path, language_id)`. Both sides
/// of the worktree comparison are canonicalized so symlink-resolved /
/// trailing-slashed inputs collide cleanly.
pub async fn find_for(
    app: &AppHandle,
    worktree_path: &Path,
    language_id: &str,
) -> AppResult<Option<LspOverride>> {
    let overrides = list(app).await?;
    let target = canonicalize(worktree_path);
    Ok(overrides
        .into_iter()
        .find(|o| o.language == language_id && canonicalize(Path::new(&o.worktree)) == target))
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

/// Resolve the effective `LspConfig` for a `(worktree, language)` pair:
/// load the global config, layer the matching override on top, expand
/// `${WORKTREE_PATH}` in command/args/env/path_mapping, and default
/// `path_mapping.host_root` to the worktree path when unset.
///
/// Returns `Ok(None)` when the language has no enabled global entry —
/// preserves existing "no LSP if not enabled" behavior. Overrides do
/// NOT enable a globally-disabled language; that's a deliberate
/// constraint, since otherwise a stale per-worktree config could keep
/// resurrecting a server the user explicitly turned off.
pub async fn resolve(
    app: &AppHandle,
    worktree_path: &Path,
    language_id: &str,
) -> AppResult<Option<LspConfig>> {
    let configs = super::config::list(app).await?;
    let mut config = match configs
        .into_iter()
        .find(|c| c.id == language_id && c.enabled)
    {
        Some(c) => c,
        None => return Ok(None),
    };

    if let Some(o) = find_for(app, worktree_path, language_id).await? {
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
    config.command = substitute(&config.command, &worktree_path_str);
    config.args = config
        .args
        .into_iter()
        .map(|a| substitute(&a, &worktree_path_str))
        .collect();
    config.env = config
        .env
        .into_iter()
        .map(|(k, v)| (k, substitute(&v, &worktree_path_str)))
        .collect();

    if let Some(pm) = config.path_mapping.as_mut() {
        pm.remote_root = substitute(&pm.remote_root, &worktree_path_str);
        match pm.host_root.as_mut() {
            Some(h) => *h = substitute(h, &worktree_path_str),
            None => pm.host_root = Some(worktree_path_str.clone()),
        }
    }

    Ok(Some(config))
}

fn substitute(s: &str, worktree_path: &str) -> String {
    s.replace("${WORKTREE_PATH}", worktree_path)
}

/// Make sure the file exists, seeding it with a header comment + worked
/// example on first call. Used by the "Edit overrides" command so the
/// user opens something useful instead of a blank file.
pub async fn ensure_file(app: &AppHandle) -> AppResult<PathBuf> {
    let path = config_path(app)?;
    if tokio::fs::metadata(&path).await.is_err() {
        if let Some(dir) = path.parent() {
            let _ = tokio::fs::create_dir_all(dir).await;
        }
        tokio::fs::write(&path, SEED_HEADER)
            .await
            .map_err(|e| AppError::Io(format!("seed {}: {e}", path.display())))?;
    }
    Ok(path)
}
