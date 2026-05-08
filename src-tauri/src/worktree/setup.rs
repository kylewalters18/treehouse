//! Per-worktree lifecycle hooks. A workspace can declare a sequence
//! of shell commands to run automatically on worktree create
//! (`devcontainer up`, `npm install`, …) and again on remove
//! (`docker rm -f`, port-forward teardown, …). No
//! container/shell-CLI assumptions baked in; the steps are just
//! `command + args + env` and the user wires whatever they want.
//!
//! Two layers, in priority order:
//!
//! 1. **In-repo** — `<repo_root>/.treehouse/worktree-setup.toml`.
//!    Lives with the code, so teammates inherit the same setup.
//! 2. **User-level** — `treehouse.toml` `[[worktree.on_create]]` /
//!    `[[worktree.on_destroy]]` blocks scoped by `workspace`.
//!    Per-machine, not committed.
//!
//! The first layer that returns any steps wins outright (no merge).
//! No config at either layer = no hook = behavior identical to before.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use ts_rs::TS;

use crate::util::errors::{AppError, AppResult};

const REPO_FILE: &str = ".treehouse/worktree-setup.toml";

/// One command in a hook chain. Used by both `on_create` (executed
/// in a renderer-mounted terminal tab so the user sees output live)
/// and `on_destroy` (executed inline on the Rust side, since the
/// worktree disappears mid-run).
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HookStep {
    /// Human label echoed before the command runs. Just for the user
    /// reading the terminal output / trace logs; not used for logic.
    pub name: String,
    /// Program to invoke (looked up on `$PATH`, or absolute).
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// Which lifecycle moment a hook chain runs on.
#[derive(Debug, Clone, Copy)]
pub enum Hook {
    OnCreate,
    OnDestroy,
}

/// In-repo file shape: top-level `[[on_create]]` and `[[on_destroy]]`
/// arrays of tables. Either may be absent.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct WorkspaceSetup {
    #[serde(default)]
    on_create: Vec<HookStep>,
    #[serde(default)]
    on_destroy: Vec<HookStep>,
}

/// Resolve the requested hook chain for `repo_root`. In-repo wins
/// outright when present (returns its list, even if empty for the
/// asked-for hook); otherwise falls through to the user-level
/// `[[worktree.on_create]]` / `[[worktree.on_destroy]]` entries in
/// `treehouse.toml`. Returns an empty list if neither layer has
/// anything — opt-in by design.
pub async fn resolve(
    app: &AppHandle,
    repo_root: &Path,
    hook: Hook,
) -> AppResult<Vec<HookStep>> {
    if let Some(steps) = read_repo(repo_root, hook).await? {
        return Ok(steps);
    }
    read_user(app, repo_root, hook).await
}

async fn read_repo(
    repo_root: &Path,
    hook: Hook,
) -> AppResult<Option<Vec<HookStep>>> {
    let path = repo_root.join(REPO_FILE);
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => {
            let f: WorkspaceSetup = toml::from_str(&s).map_err(|e| {
                AppError::Unknown(format!("parse {}: {e}", path.display()))
            })?;
            // In-repo file decides priority for the WHOLE config —
            // i.e. once the file exists at all, we stop falling
            // through to user-level even for the not-asked-for hook.
            // Prevents user-level on_destroy from accidentally
            // running against a repo that's deliberately committed
            // an empty in-repo override.
            if f.on_create.is_empty() && f.on_destroy.is_empty() {
                Ok(None)
            } else {
                Ok(Some(match hook {
                    Hook::OnCreate => f.on_create,
                    Hook::OnDestroy => f.on_destroy,
                }))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::Io(format!("read {}: {e}", path.display()))),
    }
}

async fn read_user(
    app: &AppHandle,
    repo_root: &Path,
    hook: Hook,
) -> AppResult<Vec<HookStep>> {
    let cfg = crate::user_config::load(app).await?;
    let target = canonicalize(repo_root);
    let entries = match hook {
        Hook::OnCreate => cfg.worktree.on_create,
        Hook::OnDestroy => cfg.worktree.on_destroy,
    };
    let steps: Vec<HookStep> = entries
        .into_iter()
        .filter(|e| canonicalize(Path::new(&e.workspace)) == target)
        .map(|e| HookStep {
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
    steps: Vec<HookStep>,
    worktree_path: &Path,
    worktree_name: &str,
    base_branch: &str,
) -> Vec<HookStep> {
    let wp = worktree_path.to_string_lossy().to_string();
    let sub = |s: &str| -> String {
        s.replace("${WORKTREE_PATH}", &wp)
            .replace("${WORKTREE_NAME}", worktree_name)
            .replace("${BASE_BRANCH}", base_branch)
    };
    steps
        .into_iter()
        .map(|st| HookStep {
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

/// Result of running a hook chain inline (used by `on_destroy`,
/// where there's no live terminal tab to surface output). `failed`
/// carries `(step_name, reason)` for the renderer's toast.
#[derive(Debug, Clone, Serialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HookRunSummary {
    pub ran: usize,
    pub succeeded: usize,
    pub failed: Vec<HookFailure>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HookFailure {
    pub name: String,
    pub reason: String,
}

/// Run a chain of hook steps inline. Each step is a separate
/// subprocess (no shell wrapping), output is captured and forwarded
/// to `tracing` so the tauri-dev console shows what happened. Steps
/// run sequentially with a `timeout_per_step` cap; one step's
/// failure logs and is recorded but does NOT abort the chain — the
/// caller (worktree remove path) wants the rest of cleanup to still
/// have a chance, and we don't want a missing container or a flaky
/// network call to refuse a worktree deletion.
pub async fn run_inline(
    steps: Vec<HookStep>,
    cwd: &Path,
    timeout_per_step: std::time::Duration,
) -> HookRunSummary {
    let mut summary = HookRunSummary::default();
    summary.ran = steps.len();
    for step in steps {
        let label = step.name.clone();
        tracing::info!(name = %label, command = %step.command, "running hook step");
        let mut cmd = tokio::process::Command::new(&step.command);
        cmd.args(&step.args)
            .current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in &step.env {
            cmd.env(k, v);
        }
        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let reason = format!("spawn failed: {e}");
                tracing::warn!(name = %label, "{}", reason);
                summary.failed.push(HookFailure {
                    name: label,
                    reason,
                });
                continue;
            }
        };
        let result = match tokio::time::timeout(
            timeout_per_step,
            child.wait_with_output(),
        )
        .await
        {
            Ok(r) => r,
            Err(_) => {
                // On timeout the `wait_with_output` future is dropped
                // — but `kill_on_drop` on the Command builder ensures
                // the child gets SIGKILLed rather than orphaned.
                let reason = format!("timed out after {:?}", timeout_per_step);
                tracing::warn!(name = %label, "{}", reason);
                summary.failed.push(HookFailure {
                    name: label,
                    reason,
                });
                continue;
            }
        };
        match result {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if !stdout.trim().is_empty() {
                    tracing::debug!(name = %label, "{}", stdout.trim());
                }
                summary.succeeded += 1;
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
                let code = out.status.code();
                tracing::warn!(
                    name = %label,
                    code = ?code,
                    "hook step failed: {}",
                    stderr.trim()
                );
                let mut reason = match code {
                    Some(c) => format!("exit {c}"),
                    None => "killed by signal".to_string(),
                };
                let head: String = stderr.lines().take(3).collect::<Vec<_>>().join(" / ");
                if !head.is_empty() {
                    reason.push_str(": ");
                    reason.push_str(&head);
                }
                summary.failed.push(HookFailure {
                    name: label,
                    reason,
                });
            }
            Err(e) => {
                // Spawn failures are caught above; this arm is the
                // narrower "child started but `wait_with_output`
                // couldn't complete" case (e.g. an I/O error reading
                // its pipes).
                let reason = format!("wait failed: {e}");
                tracing::warn!(name = %label, "{}", reason);
                summary.failed.push(HookFailure {
                    name: label,
                    reason,
                });
            }
        }
    }
    summary
}
