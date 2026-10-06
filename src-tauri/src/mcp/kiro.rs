//! Kiro wiring. `kiro-cli` has no `--mcp-config` flag and doesn't expand
//! `${VAR}` in `mcp.json` (kirodotdev/Kiro#5988), so we can't hand it a
//! per-session server on the command line. Instead each Kiro launch gets a
//! shadow `KIRO_HOME`: a throwaway dir under treehouse's config dir where
//! every entry of the user's real Kiro home is a symlink back, except
//! `settings/mcp.json`, which is the user's global servers plus a
//! `treehouse` entry carrying this session's token.
//!
//! Nothing is written into the repo or the user's `~/.kiro`. Auth lives
//! outside `KIRO_HOME`, and a chat session creates no files of its own in
//! it, so the shadow can be deleted when the agent exits. Edits Kiro makes
//! to the user's settings land in the real files through the symlinks;
//! only a `/mcp add` in-session (which rewrites our `mcp.json`) is lost.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::util::errors::{AppError, AppResult};
use crate::util::ids::AgentSessionId;

pub const HOME_ENV: &str = "KIRO_HOME";
const SHADOW_DIR: &str = "kiro-home";

/// The user's real Kiro home: their own `KIRO_HOME` if set, else `~/.kiro`.
fn real_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os(HOME_ENV).filter(|h| !h.is_empty()) {
        return Some(PathBuf::from(h));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".kiro"))
}

fn shadow_root(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(crate::storage::config_dir(app)?.join(SHADOW_DIR))
}

/// Build the shadow home for `agent_id` and return its path, to be passed
/// to the child as `KIRO_HOME`.
pub fn install(app: &AppHandle, agent_id: AgentSessionId, server: Value) -> AppResult<PathBuf> {
    let dir = shadow_root(app)?.join(agent_id.to_string());
    build(&dir, real_home().as_deref(), server)?;
    Ok(dir)
}

/// Remove a session's shadow home once its agent has exited.
pub fn remove(dir: &Path) {
    if let Err(e) = std::fs::remove_dir_all(dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(?e, dir = %dir.display(), "kiro mcp: couldn't remove shadow home");
        }
    }
}

/// Clear shadow homes left behind by a crash. Called at boot, before any
/// agent launches, so nothing in there is in use.
pub fn sweep(app: &AppHandle) {
    if let Ok(root) = shadow_root(app) {
        remove(&root);
    }
}

fn build(dir: &Path, real: Option<&Path>, server: Value) -> AppResult<()> {
    let settings = dir.join("settings");
    std::fs::create_dir_all(&settings)
        .map_err(|e| AppError::Io(format!("create kiro shadow home: {e}")))?;
    if let Some(real) = real {
        link_entries(real, dir, "settings")?;
        link_entries(&real.join("settings"), &settings, "mcp.json")?;
    }

    let mut cfg = real
        .and_then(|r| std::fs::read(r.join("settings/mcp.json")).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let servers = cfg
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| json!({}));
    if !servers.is_object() {
        *servers = json!({});
    }
    servers
        .as_object_mut()
        .unwrap()
        .insert(super::SERVER_NAME.into(), server);
    let out = serde_json::to_string_pretty(&cfg)
        .map_err(|e| AppError::Unknown(format!("serialize kiro mcp.json: {e}")))?;
    std::fs::write(settings.join("mcp.json"), out)
        .map_err(|e| AppError::Io(format!("write kiro mcp.json: {e}")))
}

/// Symlink every entry of `from` into `to`, except `skip`. A missing `from`
/// (no Kiro home yet) links nothing.
fn link_entries(from: &Path, to: &Path, skip: &str) -> AppResult<()> {
    let entries = match std::fs::read_dir(from) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(AppError::Io(format!("read {}: {e}", from.display()))),
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name == skip {
            continue;
        }
        std::os::unix::fs::symlink(entry.path(), to.join(&name))
            .map_err(|e| AppError::Io(format!("link {}: {e}", entry.path().display())))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(p: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
    }

    #[test]
    fn mirrors_real_home_and_merges_servers() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir_all(real.join("agents")).unwrap();
        std::fs::create_dir_all(real.join("settings")).unwrap();
        std::fs::write(real.join("settings/cli.json"), "{}").unwrap();
        std::fs::write(
            real.join("settings/mcp.json"),
            r#"{ "mcpServers": { "other": { "command": "x" } }, "keep": 1 }"#,
        )
        .unwrap();

        let shadow = tmp.path().join("shadow");
        build(&shadow, Some(&real), json!({ "url": "a" })).unwrap();

        assert!(shadow
            .join("agents")
            .symlink_metadata()
            .unwrap()
            .is_symlink());
        assert!(shadow
            .join("settings/cli.json")
            .symlink_metadata()
            .unwrap()
            .is_symlink());
        let mcp = shadow.join("settings/mcp.json");
        assert!(!mcp.symlink_metadata().unwrap().is_symlink());
        let v = read(&mcp);
        assert_eq!(v["keep"], 1);
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["mcpServers"][super::super::SERVER_NAME]["url"], "a");

        // The user's own config is untouched, and removal doesn't follow links.
        let before = std::fs::read_to_string(real.join("settings/mcp.json")).unwrap();
        remove(&shadow);
        assert!(!shadow.exists());
        assert!(real.join("agents").is_dir());
        assert_eq!(
            std::fs::read_to_string(real.join("settings/mcp.json")).unwrap(),
            before
        );
    }

    #[test]
    fn works_without_a_real_home() {
        let tmp = tempfile::tempdir().unwrap();
        let shadow = tmp.path().join("shadow");
        build(
            &shadow,
            Some(&tmp.path().join("missing")),
            json!({ "url": "a" }),
        )
        .unwrap();
        let v = read(&shadow.join("settings/mcp.json"));
        assert_eq!(v["mcpServers"][super::super::SERVER_NAME]["url"], "a");
    }
}
