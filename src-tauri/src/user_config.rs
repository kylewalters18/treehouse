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
use ts_rs::TS;

use crate::agent::patterns::{AgentPatterns, BackendPatterns};
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
///
/// `rename_all = "camelCase"` is a no-op for the current field names
/// (all single words) but matches the rest of the IPC surface and
/// guards future multi-word fields. Safe for TOML too, since none of
/// the keys actually change.
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
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

/// Insert or replace a `[[lsp.language]]` entry in `treehouse.toml`,
/// matched by `config.id`. Format- and comment-preserving (uses
/// `toml_edit`), so the rest of the user's file — including their
/// comments — survives the write; this is what lets the Settings UI
/// edit configs without the lossy full rewrite we reserve for one-time
/// migration. Editing a built-in "forks" it into an explicit entry
/// that overrides the code-seeded default at runtime (see
/// `lsp::config::list`); call [`remove_language`] to drop the fork and
/// fall back to the default.
pub async fn upsert_language(app: &AppHandle, config: &LspConfig) -> AppResult<()> {
    let path = ensure_file(app).await?;
    let text = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::Io(format!("read {}: {e}", path.display())))?;
    let out = upsert_language_in(&text, config)
        .map_err(|e| AppError::Unknown(format!("edit {}: {e}", path.display())))?;
    tokio::fs::write(&path, out)
        .await
        .map_err(|e| AppError::Io(format!("write {}: {e}", path.display())))?;
    Ok(())
}

/// Pure core of [`upsert_language`]: parse `text`, insert-or-replace
/// the `[[lsp.language]]` entry matched by `config.id`, return the
/// re-serialized document. Comment- and format-preserving. Split out
/// from the IO wrapper so it's unit-testable without a Tauri
/// `AppHandle`. Errors carry a plain string (no `AppError` dep).
fn upsert_language_in(text: &str, config: &LspConfig) -> Result<String, String> {
    let mut doc = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| e.to_string())?;

    // Serialize the config to a standalone document so the field shape
    // and camelCase key names match exactly what `load()` reads back,
    // then lift its keys into a table for the array-of-tables.
    let serialized = toml_edit::ser::to_document(config).map_err(|e| e.to_string())?;
    let mut entry = toml_edit::Table::new();
    for (k, v) in serialized.as_table().iter() {
        entry.insert(k, v.clone());
    }

    let arr = ensure_array_of_tables(&mut doc, "lsp", "language");
    let existing = arr
        .iter()
        .position(|t| t.get("id").and_then(|v| v.as_str()) == Some(config.id.as_str()));
    match existing {
        Some(i) => *arr.get_mut(i).unwrap() = entry,
        None => arr.push(entry),
    }
    Ok(doc.to_string())
}

/// Remove the `[[lsp.language]]` entry with the given `id` from
/// `treehouse.toml`, if present. For a built-in this restores the
/// code-seeded default; for a user-defined language it deletes it.
/// No-op (returning `Ok`) when the file or entry is absent.
/// Comment-preserving.
pub async fn remove_language(app: &AppHandle, id: &str) -> AppResult<()> {
    let path = config_path(app)?;
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(AppError::Io(format!("read {}: {e}", path.display()))),
    };
    let out = remove_language_in(&text, id)
        .map_err(|e| AppError::Unknown(format!("edit {}: {e}", path.display())))?;
    tokio::fs::write(&path, out)
        .await
        .map_err(|e| AppError::Io(format!("write {}: {e}", path.display())))?;
    Ok(())
}

/// Pure core of [`remove_language`]: drop the `[[lsp.language]]` entry
/// with `id`, preserving everything else. Unit-testable without an
/// `AppHandle`.
fn remove_language_in(text: &str, id: &str) -> Result<String, String> {
    let mut doc = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| e.to_string())?;
    if let Some(arr) = doc
        .get_mut("lsp")
        .and_then(|i| i.get_mut("language"))
        .and_then(|i| i.as_array_of_tables_mut())
    {
        arr.retain(|t| t.get("id").and_then(|v| v.as_str()) != Some(id));
    }
    Ok(doc.to_string())
}

/// IDs of the `[[lsp.language]]` entries currently defined in
/// `treehouse.toml` — i.e. the customized/forked languages. The
/// renderer uses this to label a row's destructive action ("Reset to
/// default" for a forked built-in vs "Delete" for a purely custom
/// language) and to mark built-ins as customized.
pub async fn language_ids(app: &AppHandle) -> AppResult<Vec<String>> {
    Ok(load(app)
        .await?
        .lsp
        .languages
        .into_iter()
        .map(|c| c.id)
        .collect())
}

// ---------------------------------------------------------------------------
// LSP overrides (`[[lsp.override]]`) and worktree hooks
// (`[[worktree.on_create]]` / `[[worktree.on_destroy]]`).
//
// Unlike `[[lsp.language]]`, these entries have no stable identity key
// (a workspace can carry several hooks, even same-named ones), so the
// Settings UI edits them as whole lists and we replace the array
// wholesale. Comments *inside* a replaced array section are not
// preserved — these sections are GUI-managed — but the file header and
// every other section (including hand-written `[[lsp.language]]`
// entries) survive untouched.
// ---------------------------------------------------------------------------

/// Replace the per-workspace `[[lsp.override]]` array with `overrides`.
pub async fn set_overrides(app: &AppHandle, overrides: &[LspOverride]) -> AppResult<()> {
    write_edited(app, |doc| {
        replace_array_of_tables(doc, "lsp", "override", overrides)
    })
    .await
}

/// Replace both worktree hook arrays in a single comment-preserving
/// edit. Passing two empty slices clears the section entirely.
pub async fn set_worktree_hooks(
    app: &AppHandle,
    on_create: &[WorktreeHookEntry],
    on_destroy: &[WorktreeHookEntry],
) -> AppResult<()> {
    write_edited(app, |doc| {
        replace_array_of_tables(doc, "worktree", "on_create", on_create)?;
        replace_array_of_tables(doc, "worktree", "on_destroy", on_destroy)
    })
    .await
}

/// Insert or replace the `[agent.status.<backend>]` table for one
/// backend, leaving the other backends' sections (and the rest of the
/// file) untouched. `backend_key` is the camelCase serde key
/// (`claudeCode` / `kiro` / `codex`).
pub async fn upsert_agent_backend(
    app: &AppHandle,
    backend_key: &str,
    patterns: &BackendPatterns,
) -> AppResult<()> {
    write_edited(app, |doc| upsert_agent_backend_in(doc, backend_key, patterns)).await
}

/// Drop the `[agent.status.<backend>]` table so [`agent::patterns::load`]
/// re-fills that backend's built-in defaults. Prunes the now-empty
/// `[agent.status]` / `[agent]` parents so we don't leave dangling
/// headers. No-op when absent.
pub async fn remove_agent_backend(app: &AppHandle, backend_key: &str) -> AppResult<()> {
    write_edited(app, |doc| {
        remove_agent_backend_in(doc, backend_key);
        Ok(())
    })
    .await
}

/// Backend keys (`claudeCode` / `kiro` / `codex`) that have an explicit
/// `[agent.status.<backend>]` table on disk — i.e. customized backends.
/// Drives the per-backend "Reset to default" affordance in Settings,
/// mirroring `language_ids`.
pub async fn customized_backends(app: &AppHandle) -> AppResult<Vec<String>> {
    let path = config_path(app)?;
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(format!("read {}: {e}", path.display()))),
    };
    Ok(customized_backends_in(&text))
}

/// Read-edit-write a `treehouse.toml` document through a comment-
/// preserving `toml_edit` transform. Ensures the file exists (seeding
/// the header) first, so a first-ever Settings write lands in a useful
/// file. Shared by every whole-section editor above.
async fn write_edited(
    app: &AppHandle,
    edit: impl FnOnce(&mut toml_edit::DocumentMut) -> Result<(), String>,
) -> AppResult<()> {
    let path = ensure_file(app).await?;
    let text = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::Io(format!("read {}: {e}", path.display())))?;
    let mut doc = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| AppError::Unknown(format!("parse {}: {e}", path.display())))?;
    edit(&mut doc).map_err(|e| AppError::Unknown(format!("edit {}: {e}", path.display())))?;
    tokio::fs::write(&path, doc.to_string())
        .await
        .map_err(|e| AppError::Io(format!("write {}: {e}", path.display())))?;
    Ok(())
}

/// Replace the entire `[[<parent>.<array>]]` array-of-tables with
/// `items`. Removes the array key (and the parent table if it empties)
/// when `items` is empty, so we never leave a dangling header.
fn replace_array_of_tables<T: Serialize>(
    doc: &mut toml_edit::DocumentMut,
    parent_key: &str,
    array_key: &str,
    items: &[T],
) -> Result<(), String> {
    use toml_edit::{Item, Table};
    if items.is_empty() {
        if let Some(ptable) = doc.get_mut(parent_key).and_then(Item::as_table_mut) {
            ptable.remove(array_key);
            if ptable.is_empty() {
                doc.as_table_mut().remove(parent_key);
            }
        }
        return Ok(());
    }
    let arr = ensure_array_of_tables(doc, parent_key, array_key);
    arr.clear();
    for item in items {
        let serialized = toml_edit::ser::to_document(item).map_err(|e| e.to_string())?;
        let mut entry = Table::new();
        for (k, v) in serialized.as_table().iter() {
            entry.insert(k, v.clone());
        }
        arr.push(entry);
    }
    Ok(())
}

/// Pure core of [`upsert_agent_backend`]. Builds the
/// `[agent.status.<backend>]` leaf table, creating the implicit
/// `[agent]` / `[agent.status]` parents so the output is the idiomatic
/// nested-header form rather than bare `[agent]`.
fn upsert_agent_backend_in(
    doc: &mut toml_edit::DocumentMut,
    backend_key: &str,
    patterns: &BackendPatterns,
) -> Result<(), String> {
    use toml_edit::{Item, Table};
    let root = doc.as_table_mut();
    let agent = ensure_table(root, "agent", true);
    let status = ensure_table(agent, "status", true);
    let serialized = toml_edit::ser::to_document(patterns).map_err(|e| e.to_string())?;
    let mut leaf = Table::new();
    for (k, v) in serialized.as_table().iter() {
        leaf.insert(k, v.clone());
    }
    status.insert(backend_key, Item::Table(leaf));
    Ok(())
}

/// Pure core of [`remove_agent_backend`].
fn remove_agent_backend_in(doc: &mut toml_edit::DocumentMut, backend_key: &str) {
    use toml_edit::Item;
    let root = doc.as_table_mut();
    let Some(agent) = root.get_mut("agent").and_then(Item::as_table_mut) else {
        return;
    };
    if let Some(status) = agent.get_mut("status").and_then(Item::as_table_mut) {
        status.remove(backend_key);
        if status.is_empty() {
            agent.remove("status");
        }
    }
    if agent.is_empty() {
        root.remove("agent");
    }
}

/// Pure core of [`customized_backends`].
fn customized_backends_in(text: &str) -> Vec<String> {
    let doc = match text.parse::<toml_edit::DocumentMut>() {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let status = doc.get("agent").and_then(|a| a.get("status"));
    ["claudeCode", "kiro", "codex"]
        .into_iter()
        .filter(|k| status.and_then(|s| s.get(k)).is_some())
        .map(|k| k.to_string())
        .collect()
}

/// Ensure a child table exists under `parent`, returning a mut ref.
/// `implicit` controls whether the table emits its own `[header]`
/// (false) or stays a path segment for nested leaves (true).
fn ensure_table<'a>(
    parent: &'a mut toml_edit::Table,
    key: &str,
    implicit: bool,
) -> &'a mut toml_edit::Table {
    use toml_edit::{Item, Table};
    if !parent.get(key).map(Item::is_table).unwrap_or(false) {
        let mut t = Table::new();
        t.set_implicit(implicit);
        parent.insert(key, Item::Table(t));
    }
    parent.get_mut(key).unwrap().as_table_mut().unwrap()
}

/// Find-or-create the `[[<parent>.<array>]]` array-of-tables, creating
/// the parent table as *implicit* so the output stays the idiomatic
/// `[[lsp.language]]` form rather than emitting a bare `[lsp]` header.
fn ensure_array_of_tables<'a>(
    doc: &'a mut toml_edit::DocumentMut,
    parent_key: &str,
    array_key: &str,
) -> &'a mut toml_edit::ArrayOfTables {
    use toml_edit::{ArrayOfTables, Item, Table};
    let root = doc.as_table_mut();
    if !root.get(parent_key).map(Item::is_table).unwrap_or(false) {
        let mut t = Table::new();
        t.set_implicit(true);
        root.insert(parent_key, Item::Table(t));
    }
    let ptable = root.get_mut(parent_key).unwrap().as_table_mut().unwrap();
    if !ptable
        .get(array_key)
        .map(Item::is_array_of_tables)
        .unwrap_or(false)
    {
        ptable.insert(array_key, Item::ArrayOfTables(ArrayOfTables::new()));
    }
    ptable
        .get_mut(array_key)
        .unwrap()
        .as_array_of_tables_mut()
        .unwrap()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::LspConfig;

    fn cfg(id: &str, command: &str) -> LspConfig {
        LspConfig {
            id: id.into(),
            display_name: format!("{id} lang"),
            command: command.into(),
            args: vec!["--lsp".into()],
            filetypes: vec![id.into()],
            root_markers: vec![],
            install_hint: None,
            env: BTreeMap::new(),
            path_mapping: None,
        }
    }

    /// The whole reason we use `toml_edit` instead of a lossy rewrite:
    /// a user's comments must survive an edit from the Settings UI.
    #[test]
    fn upsert_preserves_comments_and_other_sections() {
        let src = "\
# my notes about this file
[agent.status]
attention = [\"[y/N]\"]  # inline comment kept too
";
        let out = upsert_language_in(src, &cfg("haskell", "hls")).unwrap();
        assert!(out.contains("# my notes about this file"));
        assert!(out.contains("# inline comment kept too"));
        assert!(out.contains("[agent.status]"));
        assert!(out.contains("[[lsp.language]]"));
        assert!(out.contains("id = \"haskell\""));
        // And it round-trips back through the loader's schema.
        let parsed: TreehouseConfig = toml::from_str(&out).unwrap();
        assert_eq!(parsed.lsp.languages.len(), 1);
        assert_eq!(parsed.lsp.languages[0].command, "hls");
    }

    #[test]
    fn upsert_replaces_matching_id_without_duplicating() {
        let src = "";
        let once = upsert_language_in(src, &cfg("rust", "rust-analyzer")).unwrap();
        let twice = upsert_language_in(&once, &cfg("rust", "/custom/ra")).unwrap();
        let parsed: TreehouseConfig = toml::from_str(&twice).unwrap();
        assert_eq!(parsed.lsp.languages.len(), 1);
        assert_eq!(parsed.lsp.languages[0].command, "/custom/ra");
    }

    #[test]
    fn upsert_keeps_distinct_ids_side_by_side() {
        let a = upsert_language_in("", &cfg("rust", "rust-analyzer")).unwrap();
        let b = upsert_language_in(&a, &cfg("go", "gopls")).unwrap();
        let parsed: TreehouseConfig = toml::from_str(&b).unwrap();
        assert_eq!(parsed.lsp.languages.len(), 2);
    }

    #[test]
    fn remove_drops_entry_and_keeps_comments() {
        let with = upsert_language_in("# keep me\n", &cfg("rust", "rust-analyzer")).unwrap();
        let without = remove_language_in(&with, "rust").unwrap();
        assert!(without.contains("# keep me"));
        let parsed: TreehouseConfig = toml::from_str(&without).unwrap();
        assert!(parsed.lsp.languages.is_empty());
    }

    #[test]
    fn remove_missing_id_is_a_noop() {
        let src = "# nothing here\n";
        let out = remove_language_in(src, "rust").unwrap();
        assert!(out.contains("# nothing here"));
    }

    fn parse(text: &str) -> toml_edit::DocumentMut {
        text.parse().unwrap()
    }

    fn hook(workspace: &str, name: &str) -> WorktreeHookEntry {
        WorktreeHookEntry {
            workspace: workspace.into(),
            name: name.into(),
            command: "echo".into(),
            args: vec!["hi".into()],
            env: BTreeMap::new(),
        }
    }

    // A retained, self-contained section unrelated to worktree hooks,
    // with a leading comment — lets us assert that a hook edit leaves
    // other sections and document content intact.
    const KEPT_SECTION: &str = "# keep me\n[agent.status.codex]\nattention = [\"[y/N]\"]\n";

    #[test]
    fn replace_array_keeps_other_sections_and_round_trips() {
        let mut doc = parse(KEPT_SECTION);
        replace_array_of_tables(
            &mut doc,
            "worktree",
            "on_create",
            &[hook("/repo", "bring up")],
        )
        .unwrap();
        let out = doc.to_string();
        assert!(out.contains("# keep me"));
        assert!(out.contains("[agent.status.codex]"));
        let parsed: TreehouseConfig = toml::from_str(&out).unwrap();
        assert_eq!(parsed.worktree.on_create.len(), 1);
        assert_eq!(parsed.worktree.on_create[0].name, "bring up");
        assert_eq!(parsed.agent.status.codex.attention, vec!["[y/N]"]);
    }

    #[test]
    fn replace_array_with_empty_drops_the_section() {
        let src = format!(
            "{KEPT_SECTION}\n[[worktree.on_create]]\nworkspace = \"/r\"\nname = \"x\"\ncommand = \"c\"\n"
        );
        let mut doc = parse(&src);
        replace_array_of_tables::<WorktreeHookEntry>(&mut doc, "worktree", "on_create", &[])
            .unwrap();
        let out = doc.to_string();
        assert!(out.contains("# keep me"));
        assert!(out.contains("[agent.status.codex]"));
        assert!(!out.contains("worktree"));
        let parsed: TreehouseConfig = toml::from_str(&out).unwrap();
        assert!(parsed.worktree.on_create.is_empty());
    }

    #[test]
    fn upsert_agent_backend_is_per_backend_and_resettable() {
        let bp = BackendPatterns {
            attention: vec!["needs you".into()],
            idle: vec![],
        };
        let mut doc = parse("# notes\n");
        upsert_agent_backend_in(&mut doc, "kiro", &bp).unwrap();
        let out = doc.to_string();
        assert!(out.contains("# notes"));
        assert!(out.contains("[agent.status.kiro]"));
        let parsed: TreehouseConfig = toml::from_str(&out).unwrap();
        assert_eq!(parsed.agent.status.kiro.attention, vec!["needs you"]);
        assert_eq!(customized_backends_in(&out), vec!["kiro".to_string()]);

        // Reset prunes the whole agent section back out.
        let mut doc2 = parse(&out);
        remove_agent_backend_in(&mut doc2, "kiro");
        let out2 = doc2.to_string();
        assert!(out2.contains("# notes"));
        assert!(!out2.contains("agent"));
        assert!(customized_backends_in(&out2).is_empty());
    }

    #[test]
    fn upsert_agent_backend_leaves_other_backends_intact() {
        let mut doc = parse("[agent.status.codex]\nattention = [\"[y/N]\"]\n");
        upsert_agent_backend_in(
            &mut doc,
            "kiro",
            &BackendPatterns {
                attention: vec!["approve".into()],
                idle: vec![],
            },
        )
        .unwrap();
        let parsed: TreehouseConfig = toml::from_str(&doc.to_string()).unwrap();
        assert_eq!(parsed.agent.status.codex.attention, vec!["[y/N]"]);
        assert_eq!(parsed.agent.status.kiro.attention, vec!["approve"]);
    }
}
