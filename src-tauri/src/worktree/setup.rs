//! Per-worktree post-create hooks. Lets a workspace declare a sequence
//! of shell commands ("bring up the devcontainer", "install deps", …)
//! that run automatically when a new worktree is created. No
//! container/shell assumptions baked in; the steps are just
//! `command + args + env` and the user wires whatever they want.
//!
//! Two layers, in priority order:
//!
//! 1. **In-repo** — `<repo_root>/.treehouse/worktree-setup.toml`.
//!    Lives with the code, so teammates inherit the same setup.
//! 2. **User-level** — `<app_config>/workspace_setup.toml`, keyed by
//!    repo absolute path. Per-machine, not committed.
//!
//! The first layer that returns any steps wins outright (no merge).
//! No file at either path = no hook = behavior identical to before.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use ts_rs::TS;

use crate::util::errors::{AppError, AppResult};

const REPO_FILE: &str = ".treehouse/worktree-setup.toml";
const USER_FILE: &str = "workspace_setup.toml";

/// One command in the post-create chain. Steps run sequentially in a
/// single shell session — see the script-builder in the renderer for
/// how `&&` chaining + a final drop-into-shell are stitched together.
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OnCreateStep {
    /// Human label echoed before the command runs. Just for the user
    /// reading the terminal output; not used for logic.
    pub name: String,
    /// Program to invoke (looked up on `$PATH`, or absolute).
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// File shape for both the in-repo and user-level files (user-level
/// nests one of these under each repo path; see `UserSetupFile`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct WorkspaceSetup {
    #[serde(default)]
    on_create: Vec<OnCreateStep>,
}

/// User-level file shape: `[[on_create]]` blocks scoped by `workspace`
/// (repo absolute path). A single file holds setup for every workspace
/// the user has configured.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct UserSetupFile {
    #[serde(rename = "on_create", default)]
    entries: Vec<UserSetupEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct UserSetupEntry {
    /// Repo absolute path (canonicalized at compare time).
    workspace: String,
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

fn user_config_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Unknown(format!("config dir: {e}")))?;
    Ok(dir.join(USER_FILE))
}

/// Resolve the post-create hook for `repo_root`. Returns an empty
/// list if no config is present at either layer — opt-in by design.
pub async fn resolve(app: &AppHandle, repo_root: &Path) -> AppResult<Vec<OnCreateStep>> {
    if let Some(steps) = read_repo(repo_root).await? {
        return Ok(steps);
    }
    read_user(app, repo_root).await
}

async fn read_repo(repo_root: &Path) -> AppResult<Option<Vec<OnCreateStep>>> {
    let path = repo_root.join(REPO_FILE);
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => {
            let f: WorkspaceSetup = toml::from_str(&s).map_err(|e| {
                AppError::Unknown(format!("parse {}: {e}", path.display()))
            })?;
            if f.on_create.is_empty() {
                Ok(None)
            } else {
                Ok(Some(f.on_create))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::Io(format!("read {}: {e}", path.display()))),
    }
}

async fn read_user(app: &AppHandle, repo_root: &Path) -> AppResult<Vec<OnCreateStep>> {
    let path = user_config_path(app)?;
    let s = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(format!("read {}: {e}", path.display()))),
    };
    let f: UserSetupFile = toml::from_str(&s)
        .map_err(|e| AppError::Unknown(format!("parse {}: {e}", path.display())))?;
    let target = canonicalize(repo_root);
    let steps: Vec<OnCreateStep> = f
        .entries
        .into_iter()
        .filter(|e| canonicalize(Path::new(&e.workspace)) == target)
        .map(|e| OnCreateStep {
            name: e.name,
            command: e.command,
            args: e.args,
            env: e.env,
        })
        .collect();
    Ok(steps)
}

/// Best-effort canonicalization. Same shape as the LSP overrides
/// resolver — falls back to a normalized string so not-yet-existing
/// paths still match exact-string user entries.
fn canonicalize(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| {
        let s = p.to_string_lossy();
        let trimmed = s.trim_end_matches('/');
        PathBuf::from(trimmed)
    })
}

/// Substitute `${WORKTREE_PATH}`, `${WORKTREE_NAME}`, `${BASE_BRANCH}`
/// in step command/args/env values. Done up-front (server-side) so the
/// renderer just stitches together a script string with literal values
/// — no env smuggling needed.
pub fn apply_templates(
    steps: Vec<OnCreateStep>,
    worktree_path: &Path,
    worktree_name: &str,
    base_branch: &str,
) -> Vec<OnCreateStep> {
    let wp = worktree_path.to_string_lossy().to_string();
    let sub = |s: &str| -> String {
        s.replace("${WORKTREE_PATH}", &wp)
            .replace("${WORKTREE_NAME}", worktree_name)
            .replace("${BASE_BRANCH}", base_branch)
    };
    steps
        .into_iter()
        .map(|st| OnCreateStep {
            name: sub(&st.name),
            command: sub(&st.command),
            args: st.args.iter().map(|a| sub(a)).collect(),
            env: st
                .env
                .into_iter()
                .map(|(k, v)| (k, sub(&v)))
                .collect(),
        })
        .collect()
}

/// Touch `<worktree>/.treehouse/setup-ran` after a successful run.
/// Not consumed in v1 — exists for a future "re-run setup" command
/// to know what's already been done, and as a breadcrumb users can
/// grep / `ls -la` for to confirm setup ran.
pub async fn mark_ran(worktree_path: &Path) -> AppResult<()> {
    let dir = worktree_path.join(".treehouse");
    let _ = tokio::fs::create_dir_all(&dir).await;
    let path = dir.join("setup-ran");
    tokio::fs::write(&path, b"")
        .await
        .map_err(|e| AppError::Io(format!("touch {}: {e}", path.display())))?;
    Ok(())
}
