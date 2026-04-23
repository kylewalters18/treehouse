//! Opt-in language config persisted as TOML in `<app_config>/languages.toml`.
//!
//! On first read the file is seeded with a curated list of common
//! servers, all `enabled = false`. Users flip entries to opt in. Custom
//! servers not in the curated list can be appended by editing the file
//! directly — we just read whatever is there.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::util::errors::{AppError, AppResult};

use super::LspConfig;

const LANGUAGES_FILE: &str = "languages.toml";

/// TOML wrapper — `[[language]]` arrays-of-tables produce readable files.
#[derive(Debug, Serialize, Deserialize, Default)]
struct LanguagesFile {
    #[serde(rename = "language", default)]
    languages: Vec<LspConfig>,
}

fn config_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Unknown(format!("config dir: {e}")))?;
    Ok(dir.join(LANGUAGES_FILE))
}

/// Read the full list, seeding + writing defaults on first call.
pub async fn list(app: &AppHandle) -> AppResult<Vec<LspConfig>> {
    let path = config_path(app)?;
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => {
            let file: LanguagesFile = toml::from_str(&s)
                .map_err(|e| AppError::Unknown(format!("parse languages.toml: {e}")))?;
            if file.languages.is_empty() {
                seed_and_save(app).await
            } else {
                Ok(file.languages)
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => seed_and_save(app).await,
        Err(e) => Err(AppError::Io(format!("read {}: {e}", path.display()))),
    }
}

pub async fn save(app: &AppHandle, items: &[LspConfig]) -> AppResult<()> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    let file = LanguagesFile {
        languages: items.to_vec(),
    };
    let s = toml::to_string_pretty(&file)
        .map_err(|e| AppError::Unknown(format!("serialize languages: {e}")))?;
    tokio::fs::write(&path, s)
        .await
        .map_err(|e| AppError::Io(format!("write {}: {e}", path.display())))?;
    Ok(())
}

/// Insert or replace by `id`. Returns the full list post-write.
pub async fn upsert(app: &AppHandle, config: LspConfig) -> AppResult<Vec<LspConfig>> {
    let mut items = list(app).await?;
    if let Some(existing) = items.iter_mut().find(|c| c.id == config.id) {
        *existing = config;
    } else {
        items.push(config);
    }
    save(app, &items).await?;
    Ok(items)
}

async fn seed_and_save(app: &AppHandle) -> AppResult<Vec<LspConfig>> {
    let seeded = seeded();
    save(app, &seeded).await?;
    Ok(seeded)
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
            enabled: false,
            install_hint: Some(hint.into()),
            env: BTreeMap::new(),
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
