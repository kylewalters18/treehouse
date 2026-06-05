//! Shared runner for the forge CLIs (`glab` / `gh`). Runs in the workspace
//! root as cwd with the parsed host exported (`GITLAB_HOST`/`GH_HOST`) so a
//! self-managed instance resolves without `glab`/`gh` inferring the host from
//! the repo remote — important because a treehouse repo may even have a
//! *GitHub* remote while we're driving `glab`. `gh`/`glab` are reachable
//! because `lib.rs::import_shell_path` seeds the login-shell PATH at startup.

use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;

use crate::util::errors::{AppError, AppResult};

/// Run `bin` with `args` in `cwd`. `--form`/`-f` fields are just argv elements
/// (no shell), so multipart bodies and free-text comments pass through safely.
/// Maps a missing binary and a nonzero exit both to `AppError::Forge`.
pub async fn run(bin: &str, cwd: &Path, host: Option<&str>, args: &[String]) -> AppResult<String> {
    let mut cmd = Command::new(bin);
    cmd.current_dir(cwd).args(args);
    if let Some(h) = host {
        // Harmless to set both; each CLI reads only its own.
        cmd.env("GITLAB_HOST", h).env("GH_HOST", h);
    }
    let out = cmd.output().await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::Forge(format!("{bin} is not installed (not found on PATH)"))
        } else {
            AppError::Forge(format!("spawn {bin}: {e}"))
        }
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("{bin} exited {:?}", out.status.code())
        } else {
            format!("{bin}: {stderr}")
        };
        return Err(AppError::Forge(msg));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Cheap "is the CLI on PATH" probe (`bin --version`). Never errors — a
/// missing binary just returns false so `forge_status` can report it.
pub async fn installed(bin: &str) -> bool {
    Command::new(bin)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Keep the last `max_bytes` of a (possibly multi-MB) job log, prefixed with a
/// truncation marker — bounded so feeding it to an agent's stdin doesn't blow
/// its context. Cuts on a line boundary.
pub fn tail_bounded(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let start = s.len() - max_bytes;
    let cut = s[start..].find('\n').map(|i| start + i + 1).unwrap_or(start);
    format!("…(log truncated to last {max_bytes} bytes)…\n{}", &s[cut..])
}
