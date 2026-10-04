//! Treehouse's own MCP server, exposed to the agents treehouse launches so an
//! agent can fan work out into sibling worktrees — each one lands in the
//! sidebar exactly as if the user had clicked "New worktree".
//!
//! Shape:
//! - One Streamable-HTTP endpoint (`POST /mcp`, JSON responses only, no SSE)
//!   bound to `127.0.0.1` on an OS-assigned port at boot. See `server`.
//! - Every Claude Code launch mints a bearer token tied to that agent session
//!   and gets the server injected via `--mcp-config` (never written into the
//!   repo). The token is how a tool call knows its caller's workspace and
//!   parent worktree; it stops working once the agent exits.
//! - Tools live in `tools`: `create_issue`, `create_worktree`, `create_pr`
//!   (worktree agents only), plus `list_repos` for the global scratch agent
//!   (`crate::scratch`), which isn't in any repo and so has to name one. A
//!   repo planner (`crate::planner`) is scoped to its repo.
//! - Gating is Claude Code's own permission prompt: we don't pre-approve the
//!   tool, so each call asks the user in the parent agent's pane (which also
//!   flips that worktree to needs-attention in the sidebar).

mod server;
mod tools;

use std::io::Read;
use std::sync::OnceLock;

use dashmap::DashMap;
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::agent::AgentBackendKind;
use crate::state::AppState;
use crate::util::ids::{AgentSessionId, WorkspaceId, WorktreeId};

pub use server::start;

/// Server name as the agent sees it; tools surface as `mcp__treehouse__*`.
pub const SERVER_NAME: &str = "treehouse";
/// Who's calling: the agent session a token was minted for.
#[derive(Debug, Clone, Copy)]
pub struct McpCaller {
    pub agent_id: AgentSessionId,
    pub scope: CallerScope,
}

/// Where the calling agent lives, which decides the tool set and where
/// `create_worktree` puts things.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallerScope {
    /// An agent inside a worktree: new worktrees go in the same repo.
    Worktree(WorktreeId),
    /// The global scratch agent: no repo of its own, names one per call.
    Scratch,
    /// A repo's ⌘J planner (`crate::planner`): acts on that repo, but has no
    /// worktree of its own (so no `create_pr`).
    Planner(WorkspaceId),
}

pub struct McpRegistry {
    port: OnceLock<u16>,
    tokens: DashMap<String, McpCaller>,
}

impl McpRegistry {
    pub fn new() -> Self {
        Self {
            port: OnceLock::new(),
            tokens: DashMap::new(),
        }
    }

    pub fn port(&self) -> Option<u16> {
        self.port.get().copied()
    }

    fn mint(&self, caller: McpCaller) -> String {
        let token = random_token();
        self.tokens.insert(token.clone(), caller);
        token
    }

    fn resolve(&self, token: &str) -> Option<McpCaller> {
        self.tokens.get(token).map(|e| *e.value())
    }

    fn revoke(&self, token: &str) {
        self.tokens.remove(token);
    }
}

/// The `--mcp-config` JSON for a Claude Code launch, minting a token for
/// `agent_id`. `None` for other backends or if the server never came up —
/// the agent then just runs without treehouse tools.
pub fn claude_config_for(
    app: &AppHandle,
    backend: AgentBackendKind,
    agent_id: AgentSessionId,
    worktree_id: WorktreeId,
) -> Option<String> {
    if !matches!(backend, AgentBackendKind::ClaudeCode) {
        return None;
    }
    let state = app.try_state::<AppState>()?;
    let mcp = &state.mcp;
    let port = mcp.port()?;
    let scope = if worktree_id == state.scratch.worktree_id {
        CallerScope::Scratch
    } else if let Some(ws) = state.planners.workspace_for(worktree_id) {
        CallerScope::Planner(ws)
    } else {
        CallerScope::Worktree(worktree_id)
    };
    let token = mcp.mint(McpCaller { agent_id, scope });
    Some(
        json!({
            "mcpServers": {
                SERVER_NAME: {
                    "type": "http",
                    "url": format!("http://127.0.0.1:{port}/mcp"),
                    "headers": { "Authorization": format!("Bearer {token}") },
                }
            }
        })
        .to_string(),
    )
}

fn random_token() -> String {
    let mut buf = [0u8; 24];
    // macOS-only app; /dev/urandom is always there. Fall back to ULIDs
    // (80 random bits each) rather than panic if it somehow isn't.
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .is_err()
    {
        return format!("{}{}", ulid::Ulid::new(), ulid::Ulid::new());
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Split a command line into argv — mirrors `src/lib/shell-words.ts` so a
/// headless launch resolves the user's configured agent command exactly the
/// way the AgentPane launcher does.
pub(crate) fn split_command(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else if q == '"' && c == '\\' {
                match chars.next() {
                    Some(n) => cur.push(n),
                    None => cur.push(c),
                }
            } else {
                cur.push(c);
            }
            continue;
        }
        match c {
            '"' | '\'' => {
                quote = Some(c);
                started = true;
            }
            '\\' => {
                match chars.next() {
                    Some(n) => cur.push(n),
                    None => cur.push(c),
                }
                started = true;
            }
            ' ' | '\t' | '\n' | '\r' => {
                if started {
                    out.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            _ => {
                cur.push(c);
                started = true;
            }
        }
    }
    if started {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_resolve_until_revoked_and_are_unique() {
        let reg = McpRegistry::new();
        let caller = McpCaller {
            agent_id: AgentSessionId::new(),
            scope: CallerScope::Worktree(WorktreeId::new()),
        };
        let a = reg.mint(caller);
        let b = reg.mint(caller);
        assert_ne!(a, b);
        assert_eq!(a.len(), 48);
        assert_eq!(reg.resolve(&a).unwrap().agent_id, caller.agent_id);
        reg.revoke(&a);
        assert!(reg.resolve(&a).is_none());
        assert!(reg.resolve(&b).is_some());
    }

    #[test]
    fn split_command_matches_frontend_rules() {
        assert_eq!(split_command("claude"), vec!["claude"]);
        assert_eq!(
            split_command(r#"claude --agent "code reviewer"  -x"#),
            vec!["claude", "--agent", "code reviewer", "-x"]
        );
        assert_eq!(
            split_command(r#"a "b\"c" 'd\e' f\ g"#),
            vec!["a", "b\"c", "d\\e", "f g"]
        );
        assert_eq!(split_command(r#"a "" b"#), vec!["a", "", "b"]);
        assert!(split_command("   ").is_empty());
    }
}
