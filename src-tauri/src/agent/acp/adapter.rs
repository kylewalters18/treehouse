//! Which command speaks ACP for a backend, and the treehouse-managed
//! installs behind the defaults.
//!
//! Resolution order for an ACP launch (`resolve`):
//! 1. `[agent.acp]` in treehouse.toml, verbatim — the user's override.
//! 2. A managed adapter: an npm package pinned here, installed once into
//!    `<app_config>/acp-adapters/<package>@<version>/` on first use and run
//!    from there directly (no `npx`, no registry lookup per launch).
//! 3. A native ACP mode of the backend's own CLI (Kiro's `kiro-cli acp`,
//!    on its v3 engine: standard `configOptions` and
//!    `available_commands_update`, where v2 used `_kiro.dev/*` extensions).
//!
//! Bumping a pin installs the new version beside the old one on the next
//! launch, then prunes the old one.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::agent::AgentBackendKind;
use crate::util::errors::{AppError, AppResult};

/// An npm-distributed ACP adapter at a pinned version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Managed {
    pub package: &'static str,
    pub version: &'static str,
    /// The package's `bin` entry.
    pub bin: &'static str,
}

impl Managed {
    /// Install directory name: `agentclientprotocol-claude-agent-acp@0.86.0`.
    fn dir_name(&self) -> String {
        format!("{}@{}", self.slug(), self.version)
    }

    fn slug(&self) -> String {
        self.package.trim_start_matches('@').replace('/', "-")
    }

    pub fn spec(&self) -> String {
        format!("{}@{}", self.package, self.version)
    }

    /// The binary once installed under `root`.
    fn bin_path(&self, root: &Path) -> PathBuf {
        self.bin_path_in(&root.join(self.dir_name()))
    }

    fn bin_path_in(&self, install_dir: &Path) -> PathBuf {
        install_dir.join("node_modules").join(".bin").join(self.bin)
    }
}

/// The pinned adapter for `backend`, if it uses one.
pub fn managed_for(backend: AgentBackendKind) -> Option<Managed> {
    match backend {
        AgentBackendKind::ClaudeCode => Some(Managed {
            package: "@agentclientprotocol/claude-agent-acp",
            version: "0.86.0",
            bin: "claude-agent-acp",
        }),
        AgentBackendKind::Codex => Some(Managed {
            package: "@agentclientprotocol/codex-acp",
            version: "2.1.1",
            bin: "codex-acp",
        }),
        AgentBackendKind::Kiro => None,
    }
}

/// Backends whose own CLI speaks ACP.
fn native_command(backend: AgentBackendKind) -> Option<&'static str> {
    match backend {
        AgentBackendKind::Kiro => Some("kiro-cli acp --agent-engine v3 --auth-method cli"),
        _ => None,
    }
}

/// What an ACP launch of one backend would run, for the launch menu.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AcpAdapterInfo {
    pub backend: AgentBackendKind,
    /// The `[agent.acp]` override, when set.
    pub configured: Option<String>,
    /// Human-readable description of what runs, e.g.
    /// `@agentclientprotocol/claude-agent-acp@0.86.0 (managed)`.
    pub label: String,
    /// A managed adapter that isn't installed yet: the first launch will
    /// run `npm install` before starting.
    pub needs_install: bool,
}

pub fn root_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(crate::storage::config_dir(app)?.join("acp-adapters"))
}

pub async fn info(app: &AppHandle) -> AppResult<Vec<AcpAdapterInfo>> {
    let cfg = crate::user_config::load(app).await?.agent.acp;
    let root = root_dir(app)?;
    Ok([
        AgentBackendKind::ClaudeCode,
        AgentBackendKind::Codex,
        AgentBackendKind::Kiro,
    ]
    .into_iter()
    .map(|backend| {
        let configured = cfg.configured(backend);
        let managed = managed_for(backend);
        let (label, needs_install) = match (&configured, managed) {
            (Some(c), _) => (c.clone(), false),
            (None, Some(m)) => (
                format!("{} (managed)", m.spec()),
                !m.bin_path(&root).exists(),
            ),
            (None, None) => (native_command(backend).unwrap_or("").to_string(), false),
        };
        AcpAdapterInfo {
            backend,
            configured,
            label,
            needs_install,
        }
    })
    .collect())
}

/// argv for an ACP launch of `backend` (see the module docs for order).
/// May install the managed adapter first, which takes a while once.
pub async fn resolve(app: &AppHandle, backend: AgentBackendKind) -> AppResult<Vec<String>> {
    let cfg = crate::user_config::load(app).await?.agent.acp;
    if let Some(cmd) = cfg.configured(backend) {
        return Ok(crate::mcp::split_command(&cmd));
    }
    if let Some(m) = managed_for(backend) {
        let bin = ensure_installed(&root_dir(app)?, m, "npm").await?;
        return Ok(vec![bin.to_string_lossy().into_owned()]);
    }
    native_command(backend)
        .map(crate::mcp::split_command)
        .ok_or_else(|| AppError::Unknown("no ACP adapter for this backend".into()))
}

/// The env var Claude's adapter (via the Agent SDK) reads to pick the CLI
/// it drives instead of the copy bundled with the SDK.
pub const CLAUDE_EXECUTABLE_ENV: &str = "CLAUDE_CODE_EXECUTABLE";

/// argv and extra env for an ACP launch of `backend` with the default
/// adapter (may `npm install` the pinned one first). For Claude, the env
/// points the adapter at the user's own `claude` (see `claude_executable`).
pub async fn launch_spec(
    app: &AppHandle,
    backend: AgentBackendKind,
) -> AppResult<(Vec<String>, Vec<(String, String)>)> {
    let argv = resolve(app, backend).await?;
    Ok((argv, launch_env(app, backend).await))
}

/// The extra env an ACP launch of `backend` gets.
pub async fn launch_env(app: &AppHandle, backend: AgentBackendKind) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if backend == AgentBackendKind::ClaudeCode {
        if let Some(exe) = claude_executable(app).await {
            env.push((
                CLAUDE_EXECUTABLE_ENV.to_string(),
                exe.to_string_lossy().into_owned(),
            ));
        }
    }
    env
}

/// The Claude CLI a PTY tab would run — the program in Settings' Claude
/// command (default `claude`), found on the imported shell PATH — so ACP and
/// PTY sessions run the same CLI version and their conversations resume in
/// either. `None` when the user set `CLAUDE_CODE_EXECUTABLE` themselves
/// (inherited as-is) or the program isn't found (the adapter then uses its
/// bundled CLI).
pub async fn claude_executable(app: &AppHandle) -> Option<PathBuf> {
    if std::env::var_os(CLAUDE_EXECUTABLE_ENV).is_some() {
        return None;
    }
    let settings = crate::storage::load_settings(app).await.unwrap_or_default();
    let cmd = settings
        .agent_commands
        .for_backend(AgentBackendKind::ClaudeCode);
    let program = crate::mcp::split_command(cmd)
        .into_iter()
        .next()
        .unwrap_or_else(|| "claude".into());
    let found = find_executable(&program, std::env::var_os("PATH").as_deref());
    if found.is_none() {
        tracing::warn!(%program, "claude CLI not found on PATH; ACP adapter will use its bundled CLI");
    }
    found
}

/// `program` as an executable path: checked directly when it contains a
/// `/` (`~/` expanded), else searched for on `path` like a shell would.
pub fn find_executable(program: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let is_exe = |p: &Path| {
        std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    };
    if program.contains('/') {
        let p = match program.strip_prefix("~/") {
            Some(rest) => PathBuf::from(std::env::var_os("HOME")?).join(rest),
            None => PathBuf::from(program),
        };
        return is_exe(&p).then_some(p);
    }
    std::env::split_paths(path?)
        .map(|dir| dir.join(program))
        .find(|p| is_exe(p))
}

/// Serializes installs, so two tabs launched at once don't race one
/// `npm install` against another.
static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

/// Return the managed adapter's binary under `root`, installing it with
/// `npm` first if needed. Installs into a temp dir and renames into place,
/// so an interrupted install never looks finished. Prunes other versions of
/// the same package afterwards.
pub async fn ensure_installed(root: &Path, m: Managed, npm: &str) -> AppResult<PathBuf> {
    let bin = m.bin_path(root);
    if bin.exists() {
        return Ok(bin);
    }
    let _guard = INSTALL_LOCK.lock().await;
    if bin.exists() {
        return Ok(bin);
    }
    let io = |e: std::io::Error| AppError::Io(format!("ACP adapter install: {e}"));
    tokio::fs::create_dir_all(root).await.map_err(io)?;
    let tmp = root.join(format!(".{}.tmp-{}", m.dir_name(), ulid::Ulid::new()));
    tokio::fs::create_dir_all(&tmp).await.map_err(io)?;
    // A package.json keeps npm from walking up to some ancestor project.
    tokio::fs::write(tmp.join("package.json"), b"{\"private\":true}\n")
        .await
        .map_err(io)?;

    tracing::info!(spec = %m.spec(), dir = %tmp.display(), "installing acp adapter");
    let out = tokio::process::Command::new(npm)
        .args([
            "install",
            "--no-audit",
            "--no-fund",
            "--omit=dev",
            "--loglevel=error",
            &m.spec(),
        ])
        .current_dir(&tmp)
        .output()
        .await;
    let failure = match out {
        Ok(o) if o.status.success() && m.bin_path_in(&tmp).exists() => None,
        Ok(o) if o.status.success() => Some(format!(
            "npm installed {} but its `{}` binary is missing",
            m.spec(),
            m.bin
        )),
        Ok(o) => Some(format!(
            "`npm install {}` failed:\n{}",
            m.spec(),
            tail(&String::from_utf8_lossy(&o.stderr), 15)
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(format!(
            "Installing the ACP adapter needs npm (Node.js) on your PATH. Install Node, \
             or set a command for this backend under [agent.acp] in treehouse.toml. ({e})"
        )),
        Err(e) => Some(format!("couldn't run npm: {e}")),
    };
    if let Some(msg) = failure {
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        return Err(AppError::Unknown(msg));
    }

    let dest = root.join(m.dir_name());
    let _ = tokio::fs::remove_dir_all(&dest).await;
    tokio::fs::rename(&tmp, &dest).await.map_err(io)?;
    prune_other_versions(root, m).await;
    tracing::info!(spec = %m.spec(), "installed acp adapter");
    Ok(bin)
}

/// Drop installs of `m`'s package at other versions, and stray temp dirs
/// from interrupted installs of it.
async fn prune_other_versions(root: &Path, m: Managed) {
    let keep = m.dir_name();
    let prefix = format!("{}@", m.slug());
    let tmp_prefix = format!(".{prefix}");
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        return;
    };
    while let Ok(Some(e)) = entries.next_entry().await {
        let name = e.file_name().to_string_lossy().into_owned();
        if name != keep && (name.starts_with(&prefix) || name.starts_with(&tmp_prefix)) {
            let _ = tokio::fs::remove_dir_all(e.path()).await;
        }
    }
}

fn tail(s: &str, lines: usize) -> String {
    let v: Vec<&str> = s.lines().collect();
    v[v.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAKE: Managed = Managed {
        package: "@scope/fake-acp",
        version: "1.2.3",
        bin: "fake-acp",
    };

    /// A stand-in `npm` that "installs" by creating the bin, so install
    /// bookkeeping is testable without the network.
    fn fake_npm(dir: &Path, ok: bool) -> String {
        let script = dir.join(if ok { "npm-ok" } else { "npm-fail" });
        let body = if ok {
            "#!/bin/sh\nmkdir -p node_modules/.bin && touch node_modules/.bin/fake-acp\n"
        } else {
            "#!/bin/sh\necho 'E404 not found' >&2\nexit 1\n"
        };
        std::fs::write(&script, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script.to_string_lossy().into_owned()
    }

    /// Real network install of the pinned Claude adapter:
    /// `ACP_INSTALL_ROOT=/some/dir cargo test managed_install_real -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn managed_install_real() {
        let root = PathBuf::from(std::env::var("ACP_INSTALL_ROOT").expect("set ACP_INSTALL_ROOT"));
        let m = managed_for(AgentBackendKind::ClaudeCode).unwrap();
        let bin = ensure_installed(&root, m, "npm").await.unwrap();
        println!("installed: {}", bin.display());
        assert!(bin.exists());
    }

    #[test]
    fn find_executable_searches_path_in_order() {
        use std::os::unix::fs::PermissionsExt;
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let mk = |dir: &Path, mode: u32| {
            let p = dir.join("claude");
            std::fs::write(&p, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
            p
        };
        mk(a.path(), 0o644); // not executable: skipped
        let want = mk(b.path(), 0o755);
        let path = std::env::join_paths([a.path(), b.path()]).unwrap();
        assert_eq!(find_executable("claude", Some(&path)), Some(want.clone()));
        assert_eq!(find_executable("nope", Some(&path)), None);
        assert_eq!(find_executable("claude", None), None);
        // A path is checked directly, not searched.
        assert_eq!(find_executable(want.to_str().unwrap(), None), Some(want));
        assert_eq!(find_executable("/nonexistent/claude", Some(&path)), None);
    }

    #[test]
    fn layout_names() {
        assert_eq!(FAKE.dir_name(), "scope-fake-acp@1.2.3");
        assert_eq!(FAKE.spec(), "@scope/fake-acp@1.2.3");
        assert_eq!(
            FAKE.bin_path(Path::new("/r")),
            Path::new("/r/scope-fake-acp@1.2.3/node_modules/.bin/fake-acp")
        );
        assert!(managed_for(AgentBackendKind::ClaudeCode).is_some());
        assert!(managed_for(AgentBackendKind::Kiro).is_none());
    }

    #[tokio::test]
    async fn installs_once_and_prunes_old_versions() {
        let tools = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("scope-fake-acp@1.0.0");
        let stray = root.path().join(".scope-fake-acp@1.2.3.tmp-x");
        let other = root.path().join("other-acp@9.9.9");
        for d in [&old, &stray, &other] {
            std::fs::create_dir_all(d).unwrap();
        }

        let npm = fake_npm(tools.path(), true);
        let bin = ensure_installed(root.path(), FAKE, &npm).await.unwrap();
        assert!(bin.exists());
        assert!(!old.exists() && !stray.exists(), "old versions pruned");
        assert!(other.exists(), "other packages untouched");

        // Already installed: no npm run at all (a failing npm proves it).
        let failing = fake_npm(tools.path(), false);
        assert_eq!(
            ensure_installed(root.path(), FAKE, &failing).await.unwrap(),
            bin
        );
    }

    #[tokio::test]
    async fn failed_install_leaves_nothing_behind() {
        let tools = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let npm = fake_npm(tools.path(), false);
        let err = ensure_installed(root.path(), FAKE, &npm).await.unwrap_err();
        assert!(err.to_string().contains("E404"), "{err}");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);

        let missing = ensure_installed(root.path(), FAKE, "/nonexistent/npm")
            .await
            .unwrap_err();
        assert!(missing.to_string().contains("needs npm"), "{missing}");
    }
}
