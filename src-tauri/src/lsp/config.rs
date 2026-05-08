//! Language server definitions: a code-seeded list of built-ins
//! (`rust-analyzer`, `clangd`, …) plus any user-defined custom
//! servers loaded from `treehouse.toml`'s `[[lsp.language]]` section.
//!
//! The on/off state for any language — built-in or custom — lives in
//! `Settings::enabled_lsp_languages`, not here. This module is just
//! "what languages exist."

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use tauri::AppHandle;

use crate::util::errors::AppResult;

use super::LspConfig;

/// Return the full list of known languages: built-in seeds first,
/// then user-defined customs from `treehouse.toml`. Customs whose
/// `id` collides with a built-in win (last-write); lets users
/// override the seeded `args`/`command` for a built-in by adding an
/// entry with the same id.
pub async fn list(app: &AppHandle) -> AppResult<Vec<LspConfig>> {
    let mut out = seeded();
    let user = crate::user_config::load(app).await?;
    for entry in user.lsp.languages {
        if let Some(existing) = out.iter_mut().find(|c| c.id == entry.id) {
            *existing = entry;
        } else {
            out.push(entry);
        }
    }
    Ok(out)
}

/// IDs of all code-seeded built-ins. Used by the migration step to
/// distinguish "carry forward as a custom" from "this is just the
/// seeded copy and we'll re-seed it in code anyway."
pub fn builtin_ids() -> BTreeSet<&'static str> {
    seeded().into_iter().map(|c| string_to_static(c.id)).collect()
}

/// Helper: leaks the String into a &'static str. Only called once at
/// startup by `builtin_ids` callers; the leak is bounded by the
/// (small, fixed) number of seeded languages.
fn string_to_static(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn seeded() -> Vec<LspConfig> {
    fn c(
        id: &str,
        display: &str,
        command: &str,
        args: &[&str],
        filetypes: &[&str],
        root_markers: &[&str],
        hint: &str,
    ) -> LspConfig {
        LspConfig {
            id: id.into(),
            display_name: display.into(),
            command: command.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            filetypes: filetypes.iter().map(|s| s.to_string()).collect(),
            root_markers: root_markers.iter().map(|s| s.to_string()).collect(),
            install_hint: Some(hint.into()),
            env: BTreeMap::new(),
            path_mapping: None,
        }
    }
    vec![
        c(
            "rust",
            "Rust (rust-analyzer)",
            "rust-analyzer",
            &[],
            &["rust"],
            &["Cargo.toml", "rust-project.json"],
            "brew install rust-analyzer",
        ),
        c(
            "typescript",
            "TypeScript / JavaScript (typescript-language-server)",
            "typescript-language-server",
            &["--stdio"],
            &["typescript", "typescriptreact", "javascript", "javascriptreact"],
            &["tsconfig.json", "jsconfig.json", "package.json"],
            "npm i -g typescript-language-server",
        ),
        c(
            "python",
            "Python (pyright)",
            "pyright-langserver",
            &["--stdio"],
            &["python"],
            &["pyproject.toml", "setup.py", "Pipfile", ".python-version"],
            "npm i -g pyright",
        ),
        c(
            "go",
            "Go (gopls)",
            "gopls",
            &[],
            &["go"],
            &["go.mod", "go.work"],
            "go install golang.org/x/tools/gopls@latest",
        ),
        c(
            "cpp",
            "C / C++ (clangd)",
            "clangd",
            &[],
            &["c", "cpp"],
            &["compile_commands.json", ".clangd", "CMakeLists.txt"],
            "brew install llvm",
        ),
        c(
            "ruby",
            "Ruby (solargraph)",
            "solargraph",
            &["stdio"],
            &["ruby"],
            &["Gemfile", ".solargraph.yml"],
            "gem install solargraph",
        ),
        c(
            "lua",
            "Lua (lua-language-server)",
            "lua-language-server",
            &[],
            &["lua"],
            &[".luarc.json", ".luarc.jsonc"],
            "brew install lua-language-server",
        ),
    ]
}

/// Return the absolute path of `cmd` if it resolves on PATH, else None.
/// Inlined instead of pulling in a `which` crate dep — trivial walk.
pub async fn resolve_command(cmd: &str) -> AppResult<Option<String>> {
    if cmd.contains('/') {
        let p = PathBuf::from(cmd);
        return Ok(if tokio::fs::metadata(&p).await.is_ok() {
            Some(p.display().to_string())
        } else {
            None
        });
    }
    let path_env = std::env::var("PATH").unwrap_or_default();
    for dir in path_env.split(':') {
        if dir.is_empty() {
            continue;
        }
        let p = PathBuf::from(dir).join(cmd);
        if let Ok(meta) = tokio::fs::metadata(&p).await {
            if meta.is_file() {
                return Ok(Some(p.display().to_string()));
            }
        }
    }
    Ok(None)
}
