import type { AgentHistoryEntry, AgentTransport } from "@/ipc/types";

/// How a saved conversation reopens by default: the first transport Rust
/// lists for it (Claude's and other ACP sessions: ACP; Kiro's terminal
/// conversations: a terminal). Entries without the field (older mocks)
/// fall back to ACP for Claude, a terminal otherwise.
export function preferredTransport(entry: AgentHistoryEntry): AgentTransport {
  return entry.transports?.[0] ?? (entry.backend === "claudeCode" ? "acp" : "pty");
}

/// Whether the history list offers a "TUI" button: the conversation
/// reopens over ACP by default but a terminal can take it too.
export function offersTerminal(entry: AgentHistoryEntry): boolean {
  return preferredTransport(entry) === "acp" && (entry.transports?.includes("pty") ?? entry.backend === "claudeCode");
}
