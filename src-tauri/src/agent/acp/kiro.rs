//! Kiro CLI v2's slash-command extension. Instead of ACP's
//! `available_commands_update`, Kiro announces commands with a
//! `_kiro.dev/commands/available` notification and runs them through a
//! `_kiro.dev/commands/execute` request. (CLI v3 negotiates extensions
//! through `agentCapabilities._meta`; this covers v2.)
//!
//! The announcement's shape is documented by other clients: `commands`
//! are `{ name: "/agent", description, meta: { hint, … } }`, `prompts`
//! (skills, MCP prompts) are `{ name, description, arguments,
//! serverName }`. The execute request's fields aren't published; we send
//! `{ sessionId, command }` with the typed line and fall back to a plain
//! prompt if Kiro rejects it.

use serde_json::{json, Value};

use super::view::AcpCommand;

pub const COMMANDS_AVAILABLE: &str = "_kiro.dev/commands/available";
pub const COMMANDS_EXECUTE: &str = "_kiro.dev/commands/execute";

/// The composer's command list from an announcement, and the names (no
/// slash) that run through `commands/execute` — Kiro's built-in commands.
/// Prompts are listed too, but go to the agent as ordinary prompt text.
pub fn parse_available(params: &Value) -> (Vec<AcpCommand>, Vec<String>) {
    let str_of = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let mut commands = Vec::new();
    let mut executable = Vec::new();
    for c in params.get("commands").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = str_of(c, "name") else { continue };
        let name = name.trim_start_matches('/').to_string();
        if name.is_empty() {
            continue;
        }
        executable.push(name.clone());
        commands.push(AcpCommand {
            hint: c.get("meta").and_then(|m| str_of(m, "hint")),
            description: str_of(c, "description").unwrap_or_default(),
            name,
        });
    }
    for p in params.get("prompts").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = str_of(p, "name") else { continue };
        let args: Vec<String> = p
            .get("arguments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|a| str_of(a, "name"))
            .collect();
        commands.push(AcpCommand {
            hint: (!args.is_empty()).then(|| args.join(" ")),
            description: str_of(p, "description").unwrap_or_default(),
            name,
        });
    }
    (commands, executable)
}

/// Whether `text` invokes one of Kiro's built-in commands.
pub fn is_command(text: &str, executable: &[String]) -> bool {
    text.trim_start()
        .strip_prefix('/')
        .and_then(|rest| rest.split_whitespace().next())
        .is_some_and(|name| executable.iter().any(|e| e == name))
}

pub fn execute_params(session_id: &str, text: &str) -> Value {
    json!({ "sessionId": session_id, "command": text.trim() })
}

/// Text worth showing from an execute result: the first string under a
/// likely key, else nothing (the command's effects arrive as updates).
pub fn execute_output(result: &Value) -> Option<String> {
    ["message", "output", "text", "content", "result"]
        .iter()
        .find_map(|k| result.get(*k)?.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commands_and_prompts() {
        let (commands, executable) = parse_available(&json!({
            "sessionId": "s",
            "commands": [
                { "name": "/agent", "description": "Manage agents", "meta": { "hint": "swap | list" } },
                { "name": "/compact", "description": "Compact the conversation" },
            ],
            "prompts": [
                { "name": "review", "description": "Review a PR", "arguments": [{ "name": "pr" }], "serverName": "skill:config" },
            ],
            "tools": [{ "name": "fs_read" }],
            "mcpServers": [],
        }));
        let names: Vec<_> = commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["agent", "compact", "review"]);
        assert_eq!(commands[0].hint.as_deref(), Some("swap | list"));
        assert_eq!(commands[2].hint.as_deref(), Some("pr"));
        assert_eq!(executable, ["agent", "compact"]);
    }

    #[test]
    fn recognizes_builtin_commands_only() {
        let exec = vec!["agent".to_string(), "compact".to_string()];
        assert!(is_command("/agent swap", &exec));
        assert!(is_command("  /compact", &exec));
        assert!(!is_command("/review 12", &exec), "prompts go as text");
        assert!(!is_command("explain /agent", &exec));
        assert!(!is_command("/", &exec));
    }

    #[test]
    fn reads_output_text() {
        assert_eq!(execute_output(&json!({ "message": " Swapped to dev " })).as_deref(), Some("Swapped to dev"));
        assert_eq!(execute_output(&json!({})), None);
    }
}
