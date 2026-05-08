//! Unified user-edited configuration at `<app_config>/treehouse.toml`.
//!
//! Replaces the per-feature TOMLs we used to ship (`languages.toml`,
//! `worktree_lsp.toml`, `workspace_setup.toml`, `agent_status.toml`)
//! with a single file the user can edit once. App-managed UI state
//! (theme, default sync strategy, the per-language enabled flags
//! you flip from the cog menu) still lives in `settings.json` —
//! keeping those out of `treehouse.toml` preserves user comments
//! here, since `toml = "0.8"` is a lossy round-trip.
//!
//! The in-repo `<repo>/.treehouse/worktree-setup.toml` (the variant
//! committed alongside the code) is unrelated to this file and
//! keeps its own top-level shape.
//!
//! Schema:
//!
//! ```toml
//! # Custom user-defined LSP servers — layered on top of the
//! # code-seeded built-ins (rust-analyzer, clangd, …). The on/off
//! # state for any language (built-in or custom) lives in
//! # settings.json under `enabledLspLanguages`.
//! [[lsp.language]]
//! id = "haskell"
//! displayName = "Haskell (HLS)"
//! command = "haskell-language-server-wrapper"
//! args = ["--lsp"]
//! filetypes = ["haskell"]
//! rootMarkers = ["stack.yaml", "cabal.project"]
//!
//! # Per-workspace LSP overrides. Same schema as old worktree_lsp.toml.
//! [[lsp.override]]
//! workspace = "/Users/kyle/Code/repo"
//! language = "cpp"
//! command = "docker"
//! args = ["exec", "-i", "treehouse-clangd-${WORKTREE_NAME}", "clangd"]
//! [lsp.override.pathMapping]
//! remoteRoot = "/workspaces/repo"
//!
//! # User-level worktree lifecycle hooks (in-repo file is separate).
//! [[worktree.on_create]]
//! workspace = "/Users/kyle/Code/repo"
//! name = "Bring up devcontainer"
//! command = "devcontainer"
//! args = ["up", "--workspace-folder", "${WORKTREE_PATH}"]
//!
//! [[worktree.on_destroy]]
//! workspace = "/Users/kyle/Code/repo"
//! name = "Stop devcontainer"
//! command = "bash"
//! args = ["-lc", "docker rm -f $(...)"]
//!
//! # Agent status patterns — substrings scanned on PTY output.
//! [agent.status]
//! attention = ["[y/N]", "Press enter", "requires approval"]
//! idle = ["ask a question or describe a task"]
//! ```

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::agent::patterns::AgentPatterns;
use crate::lsp::overrides::LspOverride;
use crate::lsp::LspConfig;
use crate::util::errors::{AppError, AppResult};

const FILE: &str = "treehouse.toml";

/// Header comment seeded into a fresh `treehouse.toml` on first
/// migration so users opening it via the palette have a working
/// starting point. Kept short — full schema lives in the rustdoc above.
const SEED_HEADER: &str = "\
# treehouse — unified user config
#
# Replaces the per-feature TOMLs we used to ship. App-managed UI
# state (sync strategy, default agent, the per-language LSP toggle
# you flip from the cog menu) still lives in settings.json beside
# this file. Comments here are preserved across reloads (we only
# rewrite this file during one-time migration; steady state is
# user-edited).
#
# Sections (all optional):
#
#   [[lsp.language]]
#       id = \"haskell\"
#       displayName = \"Haskell (HLS)\"
#       command = \"haskell-language-server-wrapper\"
#       args = [\"--lsp\"]
#       filetypes = [\"haskell\"]
#       rootMarkers = [\"stack.yaml\", \"cabal.project\"]
#
#   [[lsp.override]]
#       workspace = \"/abs/path/to/repo\"
#       language = \"cpp\"
#       command = \"docker\"
#       args = [\"exec\", \"-i\", \"clangd-${WORKTREE_NAME}\", \"clangd\"]
#       [lsp.override.pathMapping]
#       remoteRoot = \"/workspaces/repo\"
#
#   [[worktree.on_create]]
#       workspace = \"/abs/path/to/repo\"
#       name = \"Bring up devcontainer\"
#       command = \"devcontainer\"
#       args = [\"up\", \"--workspace-folder\", \"${WORKTREE_PATH}\"]
#
#   [[worktree.on_destroy]]
#       workspace = \"/abs/path/to/repo\"
#       name = \"Stop devcontainer\"
#       command = \"bash\"
#       args = [\"-lc\", \"docker rm -f ...\"]
#
#   [agent.status]
#       attention = [\"[y/N]\", \"Press enter\", \"requires approval\"]
#       idle = [\"ask a question or describe a task\"]
#
# Reload via Cmd+Shift+P → \"Settings: Reload\".
";

/// Top-level user config.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TreehouseConfig {
    #[serde(default)]
    pub lsp: LspSection,
    #[serde(default)]
    pub worktree: WorktreeSection,
    #[serde(default)]
    pub agent: AgentSection,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LspSection {
    /// User-defined custom languages, layered on top of code-seeded
    /// built-ins (rust-analyzer, clangd, …) at runtime. Only the
    /// definition shape is here — the on/off state for both built-ins
    /// and customs lives in `settings.json`.
    #[serde(default, rename = "language")]
    pub languages: Vec<LspConfig>,
    /// Per-workspace overrides — same schema as the old
    /// `worktree_lsp.toml` `[[override]]` blocks.
    #[serde(default, rename = "override")]
    pub overrides: Vec<LspOverride>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorktreeSection {
    #[serde(default)]
    pub on_create: Vec<WorktreeHookEntry>,
    #[serde(default)]
    pub on_destroy: Vec<WorktreeHookEntry>,
}

/// User-level hook entry — `workspace` scopes which repo it applies
/// to. (In-repo `.treehouse/worktree-setup.toml` is a separate file
/// with no `workspace` field; its scope is implicit.)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorktreeHookEntry {
    pub workspace: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentSection {
    #[serde(default)]
    pub status: AgentPatterns,
}

pub fn config_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Unknown(format!("config dir: {e}")))?;
    Ok(dir.join(FILE))
}

/// Read `treehouse.toml`. Returns the default (empty) config when
/// the file doesn't exist — every section is opt-in.
pub async fn load(app: &AppHandle) -> AppResult<TreehouseConfig> {
    let path = config_path(app)?;
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => toml::from_str(&s)
            .map_err(|e| AppError::Unknown(format!("parse {}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(TreehouseConfig::default()),
        Err(e) => Err(AppError::Io(format!("read {}: {e}", path.display()))),
    }
}

/// Make sure `treehouse.toml` exists, seeding the header comment on
/// first call so the "Settings: Edit" command opens something useful.
/// Returns the absolute path either way.
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

/// One-time migration from the legacy per-feature TOMLs. Idempotent:
/// runs only when `treehouse.toml` doesn't yet exist AND at least one
/// legacy file does. Builds a `TreehouseConfig` from whatever is
/// present, writes it (with the seed header preserved), then renames
/// the legacy files to `*.toml.bak` so reruns are no-ops and users
/// can recover the originals if something looks off.
///
/// `enabled` flags from the legacy `languages.toml` get folded into
/// `Settings::enabled_lsp_languages` and saved separately, since
/// that's where on/off lives now.
///
/// Best-effort: parse failures on individual legacy files are logged
/// and that section comes through empty. A user with a malformed
/// pre-existing file shouldn't have boot fail.
pub async fn migrate(app: &AppHandle) -> AppResult<()> {
    let dest = config_path(app)?;
    if tokio::fs::metadata(&dest).await.is_ok() {
        return Ok(());
    }
    let dir = dest
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| AppError::Unknown("config dir parent missing".into()))?;
    let _ = tokio::fs::create_dir_all(&dir).await;

    let legacy_languages = dir.join("languages.toml");
    let legacy_overrides = dir.join("worktree_lsp.toml");
    let legacy_setup = dir.join("workspace_setup.toml");
    let legacy_patterns = dir.join("agent_status.toml");

    let any_legacy = [
        &legacy_languages,
        &legacy_overrides,
        &legacy_setup,
        &legacy_patterns,
    ]
    .into_iter()
    .any(|p| std::fs::metadata(p).is_ok());
    if !any_legacy {
        // Nothing to migrate; user is fresh-installed or already migrated.
        // Don't write `treehouse.toml` yet — empty file just clutters
        // their config dir; subsystems will fall back to defaults.
        return Ok(());
    }

    let mut cfg = TreehouseConfig::default();
    let mut enabled_languages: Vec<String> = Vec::new();

    // languages.toml — built-ins are re-seeded in code, so we only
    // carry forward custom IDs (anything that isn't a known built-in).
    if let Ok(s) = tokio::fs::read_to_string(&legacy_languages).await {
        match toml::from_str::<LegacyLanguages>(&s) {
            Ok(parsed) => {
                let builtins = crate::lsp::config::builtin_ids();
                for entry in parsed.languages {
                    if entry.enabled {
                        enabled_languages.push(entry.id.clone());
                    }
                    if !builtins.contains(entry.id.as_str()) {
                        cfg.lsp.languages.push(LspConfig {
                            id: entry.id,
                            display_name: entry.display_name,
                            command: entry.command,
                            args: entry.args,
                            filetypes: entry.filetypes,
                            root_markers: entry.root_markers,
                            install_hint: entry.install_hint,
                            env: entry.env,
                            path_mapping: entry.path_mapping,
                        });
                    }
                }
            }
            Err(e) => tracing::warn!(
                ?e,
                path = %legacy_languages.display(),
                "migrate: parse failed; skipping",
            ),
        }
    }

    if let Ok(s) = tokio::fs::read_to_string(&legacy_overrides).await {
        #[derive(Deserialize)]
        struct LegacyOverridesFile {
            #[serde(rename = "override", default)]
            overrides: Vec<LspOverride>,
        }
        match toml::from_str::<LegacyOverridesFile>(&s) {
            Ok(parsed) => cfg.lsp.overrides = parsed.overrides,
            Err(e) => tracing::warn!(
                ?e,
                path = %legacy_overrides.display(),
                "migrate: parse failed; skipping",
            ),
        }
    }

    if let Ok(s) = tokio::fs::read_to_string(&legacy_setup).await {
        #[derive(Deserialize)]
        struct LegacySetupFile {
            #[serde(default, rename = "on_create")]
            on_create: Vec<WorktreeHookEntry>,
            #[serde(default, rename = "on_destroy")]
            on_destroy: Vec<WorktreeHookEntry>,
        }
        match toml::from_str::<LegacySetupFile>(&s) {
            Ok(parsed) => {
                cfg.worktree.on_create = parsed.on_create;
                cfg.worktree.on_destroy = parsed.on_destroy;
            }
            Err(e) => tracing::warn!(
                ?e,
                path = %legacy_setup.display(),
                "migrate: parse failed; skipping",
            ),
        }
    }

    if let Ok(s) = tokio::fs::read_to_string(&legacy_patterns).await {
        // Legacy schema was a flat `attention = [...]` / `idle = [...]`
        // pair, applied to every backend. The defaults skewed
        // Kiro-specific (`requires approval`, the REPL banner), so we
        // map legacy customizations onto the kiro section. Users who
        // had Codex-relevant patterns can re-home them after seeing
        // the new layout in treehouse.toml.
        #[derive(Deserialize)]
        struct LegacyFlatPatterns {
            #[serde(default)]
            attention: Vec<String>,
            #[serde(default)]
            idle: Vec<String>,
        }
        match toml::from_str::<LegacyFlatPatterns>(&s) {
            Ok(parsed) => {
                if !parsed.attention.is_empty() || !parsed.idle.is_empty() {
                    cfg.agent.status.kiro = crate::agent::patterns::BackendPatterns {
                        attention: parsed.attention,
                        idle: parsed.idle,
                    };
                }
            }
            Err(e) => tracing::warn!(
                ?e,
                path = %legacy_patterns.display(),
                "migrate: parse failed; skipping",
            ),
        }
    }

    // Write treehouse.toml: header comment + serialized sections,
    // keeping the user-friendly preamble in front of the data so a
    // freshly-migrated file still teaches its own format.
    let mut out = String::from(SEED_HEADER);
    out.push('\n');
    let body = toml::to_string_pretty(&cfg)
        .map_err(|e| AppError::Unknown(format!("serialize migrated treehouse.toml: {e}")))?;
    out.push_str(&body);
    tokio::fs::write(&dest, out)
        .await
        .map_err(|e| AppError::Io(format!("write {}: {e}", dest.display())))?;

    // Fold language `enabled` flags into settings.json. Done after
    // treehouse.toml is on disk so a settings-write failure doesn't
    // re-trigger migration on next boot.
    if !enabled_languages.is_empty() {
        let mut settings = crate::storage::load_settings(app).await.unwrap_or_default();
        // Merge with whatever's already there (possibly nothing) and
        // dedupe to keep the on-disk form stable across reruns.
        settings.enabled_lsp_languages.extend(enabled_languages);
        settings.enabled_lsp_languages.sort();
        settings.enabled_lsp_languages.dedup();
        if let Err(e) = crate::storage::save_settings(app, &settings).await {
            tracing::warn!(?e, "migrate: failed to persist enabled_lsp_languages");
        }
    }

    // Rename legacies so reruns are no-ops and the user can recover
    // the originals if our migration mishandled anything. Best-effort
    // — a rename failure doesn't undo the new file.
    for legacy in [
        &legacy_languages,
        &legacy_overrides,
        &legacy_setup,
        &legacy_patterns,
    ] {
        if std::fs::metadata(legacy).is_ok() {
            let bak = legacy.with_extension("toml.bak");
            if let Err(e) = std::fs::rename(legacy, &bak) {
                tracing::warn!(?e, from = %legacy.display(), to = %bak.display(), "migrate: rename failed");
            }
        }
    }

    tracing::info!(
        path = %dest.display(),
        "migrated legacy config TOMLs into treehouse.toml",
    );
    Ok(())
}

/// Legacy schema for `languages.toml` entries — same shape as
/// `LspConfig` plus the `enabled` flag we're moving out of it.
/// Kept private to the migration path.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LegacyLanguageEntry {
    id: String,
    display_name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    filetypes: Vec<String>,
    #[serde(default)]
    root_markers: Vec<String>,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    install_hint: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default, alias = "path_mapping")]
    path_mapping: Option<crate::lsp::PathMapping>,
}

#[derive(Debug, Deserialize, Default)]
struct LegacyLanguages {
    #[serde(rename = "language", default)]
    languages: Vec<LegacyLanguageEntry>,
}
