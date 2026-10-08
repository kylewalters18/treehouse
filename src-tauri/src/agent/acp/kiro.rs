//! Kiro CLI v2's slash-command extension. Instead of ACP's
//! `available_commands_update`, Kiro announces commands with a
//! `_kiro.dev/commands/available` notification and runs them through a
//! `_kiro.dev/commands/execute` request. (CLI v3 negotiates extensions
//! through `agentCapabilities._meta`; this covers v2.)
//!
//! The announcement's shape is documented by other clients: `commands`
//! are `{ name: "/agent", description, meta: { hint, … } }`, `prompts`
//! (skills, MCP prompts) are `{ name, description, arguments,
//! serverName }`. Execute takes `{ sessionId, command: { command: <name>,
//! args: {…} } }` (a serde adjacently tagged `TuiCommand`; found by
//! probing kiro-cli 2.27): bare commands take `{}`, a few take named
//! fields (`args_for`). Commands marked `meta.local` only exist in Kiro's
//! TUI and aren't offered.

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
        if c.pointer("/meta/local").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let name = name.trim_start_matches('/').to_string();
        if name.is_empty() {
            continue;
        }
        executable.push(name.clone());
        commands.push(AcpCommand {
            hint: c
                .get("meta")
                .and_then(|m| str_of(m, "hint"))
                .filter(|h| !h.is_empty()),
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
    let line = text.trim().trim_start_matches('/');
    let (name, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
    json!({
        "sessionId": session_id,
        "command": { "command": name, "args": args_for(name, rest.trim()) },
    })
}

/// A command's `args` from the text after its name. Field names come from
/// kiro-cli's arg structs; commands not listed take `{}`.
fn args_for(name: &str, rest: &str) -> Value {
    if rest.is_empty() {
        return json!({});
    }
    match name {
        "model" => json!({ "modelName": rest }),
        "prompts" => json!({ "promptName": rest }),
        "compact" => rest
            .parse::<u64>()
            .map(|n| json!({ "targetTokens": n }))
            .unwrap_or_else(|_| json!({})),
        "rewind" => rest
            .parse::<u64>()
            .map(|n| json!({ "turnIndex": n }))
            .unwrap_or_else(|_| json!({})),
        _ => json!({}),
    }
}

/// Kiro's verdict on an execute result: `success: false` carries its
/// message as the error.
pub fn execute_failure(result: &Value) -> Option<String> {
    (result.get("success").and_then(Value::as_bool) == Some(false))
        .then(|| execute_output(result).unwrap_or_else(|| "The command failed.".into()))
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

/// Kiro's messages are plain text laid out by line; keep the breaks when
/// the transcript renders them as markdown.
pub fn as_markdown(text: &str) -> String {
    text.lines().collect::<Vec<_>>().join("  \n")
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
    fn builds_tagged_execute_params() {
        assert_eq!(
            execute_params("s", " /usage "),
            json!({ "sessionId": "s", "command": { "command": "usage", "args": {} } })
        );
        assert_eq!(
            execute_params("s", "/model claude-sonnet-4.5")["command"],
            json!({ "command": "model", "args": { "modelName": "claude-sonnet-4.5" } })
        );
        assert_eq!(
            execute_params("s", "/compact 2000")["command"]["args"],
            json!({ "targetTokens": 2000 })
        );
        assert_eq!(execute_params("s", "/tools trust x")["command"]["args"], json!({}));
    }

    #[test]
    fn skips_local_commands_and_empty_hints() {
        let (commands, executable) = parse_available(&json!({
            "commands": [
                { "name": "/chat", "description": "Sessions", "meta": { "local": true } },
                { "name": "/agent", "description": "Agents", "meta": { "hint": "" } },
            ],
        }));
        assert_eq!(executable, ["agent"]);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].hint, None);
    }

    #[test]
    fn reports_unsuccessful_results() {
        assert_eq!(
            execute_failure(&json!({ "success": false, "message": "No such agent" })).as_deref(),
            Some("No such agent")
        );
        assert_eq!(execute_failure(&json!({ "success": true, "message": "ok" })), None);
    }

    #[test]
    fn reads_output_text() {
        assert_eq!(execute_output(&json!({ "message": " Swapped to dev " })).as_deref(), Some("Swapped to dev"));
        assert_eq!(execute_output(&json!({})), None);
        assert_eq!(as_markdown("a\nb"), "a  \nb");
    }
}
