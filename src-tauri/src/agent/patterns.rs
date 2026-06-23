//! User-configurable byte patterns for agent status detection,
//! keyed by backend.
//!
//! Each backend (`claudeCode`, `kiro`, `codex`) has its own pair of
//! pattern lists — pattern matching only ever runs against the
//! current session's backend, so e.g. Kiro's `requires approval`
//! header doesn't accidentally fire for a Claude session that
//! happens to print the same words. Persisted as a section of
//! `treehouse.toml`:
//!
//! ```toml
//! [agent.status.kiro]
//! attention = ["requires approval"]
//! idle = ["ask a question or describe a task"]
//!
//! [agent.status.codex]
//! attention = ["[y/N]", "Press enter"]
//!
//! [agent.status.claudeCode]
//! # Claude's status comes from its hooks API; patterns here are a
//! # fallback for hook drops, off by default.
//! ```
//!
//! Defaults: see `defaults_for`. If `[agent.status]` is missing
//! entirely the built-in defaults apply across the board; if any
//! backend's section is fully empty we fill in that backend's
//! defaults so users can customize one without re-typing the others.
//!
//! Reads happen on the PTY reader thread per chunk, so we use a
//! `parking_lot::RwLock` and clone the matched needles out at scan
//! time. Cheap.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use ts_rs::TS;

use super::AgentBackendKind;
use crate::util::errors::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentPatterns {
    #[serde(default)]
    pub claude_code: BackendPatterns,
    #[serde(default)]
    pub kiro: BackendPatterns,
    #[serde(default)]
    pub codex: BackendPatterns,
}

/// One backend's attention + idle pattern lists. Substrings, not
/// regexes — keeps the per-chunk cost predictable and the format
/// readable for users editing `treehouse.toml`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackendPatterns {
    #[serde(default)]
    pub attention: Vec<String>,
    #[serde(default)]
    pub idle: Vec<String>,
}

impl BackendPatterns {
    fn is_empty(&self) -> bool {
        self.attention.is_empty() && self.idle.is_empty()
    }
}

impl Default for AgentPatterns {
    fn default() -> Self {
        Self::defaults()
    }
}

impl AgentPatterns {
    /// The built-in pattern set, used when the user hasn't put
    /// anything in the `[agent.status]` section of `treehouse.toml`.
    pub fn defaults() -> Self {
        Self {
            claude_code: defaults_for(AgentBackendKind::ClaudeCode),
            kiro: defaults_for(AgentBackendKind::Kiro),
            codex: defaults_for(AgentBackendKind::Codex),
        }
    }

    /// `true` if any pattern in `which` for `backend` is a substring
    /// of `chunk`. Returns `false` for backends with empty lists.
    pub fn matches(&self, backend: AgentBackendKind, chunk: &[u8], which: Which) -> bool {
        let bp = self.for_backend(backend);
        let list = match which {
            Which::Attention => &bp.attention,
            Which::Idle => &bp.idle,
        };
        list.iter().any(|p| memmem_slice(chunk, p.as_bytes()))
    }

    fn for_backend(&self, backend: AgentBackendKind) -> &BackendPatterns {
        match backend {
            AgentBackendKind::ClaudeCode => &self.claude_code,
            AgentBackendKind::Kiro => &self.kiro,
            AgentBackendKind::Codex => &self.codex,
        }
    }
}

/// Per-backend defaults. Claude Code's hooks API supersedes pattern
/// matching, so we ship empty lists there to avoid double-firing on
/// generic TUI output. Kiro and Codex have no hooks; their patterns
/// target known prompts in the CLIs we've road-tested.
fn defaults_for(backend: AgentBackendKind) -> BackendPatterns {
    match backend {
        AgentBackendKind::ClaudeCode => BackendPatterns::default(),
        AgentBackendKind::Kiro => BackendPatterns {
            attention: vec![
                // Kiro permission-approval menu header.
                "requires approval".into(),
                // Generic confirmation prompts that Kiro tools occasionally print.
                "[y/N]".into(),
                "[Y/n]".into(),
                "(y/n)".into(),
                "(Y/n)".into(),
                "(y/N)".into(),
                "Press enter".into(),
                "Press Enter".into(),
                "Press ENTER".into(),
                "press any key".into(),
            ],
            // No reliable idle substring exists for Kiro's TUI, and a stale
            // match would pin Idle for PATTERN_TTL even after work resumed.
            // Idle is detected by output going quiet instead — see the Kiro
            // arm of `supervisor::activity_for_worktree`.
            idle: vec![],
        },
        AgentBackendKind::Codex => BackendPatterns {
            attention: vec![
                "[y/N]".into(),
                "[Y/n]".into(),
                "(y/n)".into(),
                "(Y/n)".into(),
                "(y/N)".into(),
                "Press enter".into(),
                "Press Enter".into(),
                "Press ENTER".into(),
                "press any key".into(),
            ],
            idle: vec![],
        },
    }
}

#[derive(Debug, Clone, Copy)]
pub enum Which {
    Attention,
    Idle,
}

fn memmem_slice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return needle.is_empty();
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Read the `[agent.status]` section of `treehouse.toml`. Per
/// backend: if the user's section is fully empty, fill in that
/// backend's built-in defaults so a partial customization doesn't
/// silently disable the others. To explicitly disable a backend,
/// set a single non-matching pattern (e.g. `attention =
/// ["__disabled__"]`).
pub async fn load(app: &AppHandle) -> AppResult<AgentPatterns> {
    let cfg = crate::user_config::load(app).await?;
    let mut parsed = cfg.agent.status;
    if parsed.claude_code.is_empty() {
        parsed.claude_code = defaults_for(AgentBackendKind::ClaudeCode);
    }
    if parsed.kiro.is_empty() {
        parsed.kiro = defaults_for(AgentBackendKind::Kiro);
    }
    if parsed.codex.is_empty() {
        parsed.codex = defaults_for(AgentBackendKind::Codex);
    }
    Ok(parsed)
}
