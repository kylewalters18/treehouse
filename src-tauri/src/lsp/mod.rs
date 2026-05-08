//! Language Server Protocol integration.
//!
//! Architecture mirrors `agent` and `pty`: Rust owns the subprocess
//! (spawned via `std::process::Command` with stdio pipes — no TTY needed),
//! and each server streams raw bytes to the renderer over a per-session
//! `Channel<LspEvent>`. The renderer uses `monaco-languageclient` with
//! `vscode-jsonrpc` for framing, so Rust never parses LSP messages.

pub mod config;
pub mod overrides;
pub mod registry;
pub mod root;
pub mod supervisor;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::util::ids::{LspServerId, WorktreeId};

/// Filesystem-prefix translation for an LSP whose process sees a
/// different filesystem layout than the host (e.g. a containerized
/// clangd). At session-spawn time we install a JSON-RPC middleware
/// that swaps `file://${host_root}/…` ↔ `file://${remote_root}/…` on
/// every URI flowing through the connection. Host_root defaults to
/// the active worktree's absolute path when unset, so most configs
/// only need to set `remote_root`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PathMapping {
    #[serde(alias = "remote_root")]
    pub remote_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "host_root")]
    pub host_root: Option<String>,
}

/// One language's configuration. Built-ins are seeded in code (see
/// `lsp::config::seeded`); user-defined customs live in
/// `treehouse.toml` under `[[lsp.language]]`. Whether a given language
/// is on or off (built-in or custom) is a separate concern that lives
/// in `Settings::enabled_lsp_languages` — flipping the cog-menu
/// toggle writes through `update_settings`, not this struct.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LspConfig {
    /// Stable slug. `"rust"`, `"typescript"`, etc. Used as the primary key.
    pub id: String,
    pub display_name: String,
    /// Binary name (resolved via PATH) or absolute path.
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Monaco language IDs this server claims (e.g. `["typescript",
    /// "javascript"]` for typescript-language-server).
    pub filetypes: Vec<String>,
    /// Filenames to search for when resolving the workspace root, walking
    /// up from the opened file toward the worktree root.
    #[serde(default)]
    pub root_markers: Vec<String>,
    /// Shown in a toast when `command` isn't on PATH.
    #[serde(default)]
    pub install_hint: Option<String>,
    /// Environment overrides for the server process. BTreeMap for stable
    /// TOML output ordering.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// When set, install URI translation between host paths and the
    /// LSP's view of the filesystem. Most useful for containerized
    /// servers (devcontainer / docker exec / etc.). See `PathMapping`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "path_mapping"
    )]
    pub path_mapping: Option<PathMapping>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum LspServerStatus {
    Spawning,
    Running,
    Exited {
        code: Option<i32>,
    },
    Crashed {
        message: String,
    },
    /// Command not on PATH. `hint` is the `install_hint` from the config.
    NotFound {
        command: String,
        hint: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LspServerSession {
    pub id: LspServerId,
    pub worktree_id: WorktreeId,
    pub language_id: String,
    /// `file://` URL of the resolved workspace root passed to `initialize`.
    pub root_uri: String,
    pub argv: Vec<String>,
    /// Unix epoch milliseconds. `#[ts(type = "number")]` — fits safely in
    /// JS Number and avoids Tauri's BigInt-in-IPC-args quirk, same trick
    /// as `Comment::created_at`.
    #[ts(type = "number")]
    pub started_at: u64,
    pub status: LspServerStatus,
    /// Resolved path translation for this session, if any. Returned to
    /// the renderer so it can install the URI-swapping JSON-RPC
    /// middleware on the message connection. `None` means raw pass-through.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_mapping: Option<PathMapping>,
}

/// Streamed over a per-session Tauri Channel returned from `lsp_ensure`.
/// `Data` carries raw LSP frames (`Content-Length: N\r\n\r\n<json>`); the
/// renderer reassembles them via `vscode-jsonrpc`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum LspEvent {
    Data { bytes: Vec<u8> },
    Stderr { text: String },
    Status { status: LspServerStatus },
}
