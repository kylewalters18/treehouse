import { agentSubmitPrompt, agentWrite, listAgentsForWorktree } from "@/ipc/client";
import type { AgentBackendKind, AgentSessionId, WorktreeId } from "@/ipc/types";

// Bracketed-paste sequences — tells a TTY REPL (Claude Code, etc.) that the
// following bytes are a single paste, so embedded newlines aren't each
// interpreted as "submit". (Submitting goes through Rust; see
// `supervisor::submit_prompt`.)
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/// Send `text` as the agent's next prompt. Rust picks the transport: the
/// same bracketed paste + `\r` for a PTY agent, `session/prompt` for ACP.
export async function pasteAndSubmit(
  agentId: AgentSessionId,
  text: string,
): Promise<void> {
  await agentSubmitPrompt(agentId, text);
}

/// Paste `text` into an agent's prompt without submitting it.
export async function pasteText(agentId: AgentSessionId, text: string): Promise<void> {
  await agentWrite(agentId, new TextEncoder().encode(PASTE_START + text + PASTE_END));
}

/// Pick a sendable agent for a worktree: prefer `preferredId` (typically the
/// active tab) when it's still running, else the first running/starting agent.
/// Returns null when the worktree has no live agent to send to. Used by
/// callers that send directly without showing a picker.
export async function resolveSendableAgent(
  worktreeId: WorktreeId,
  preferredId: AgentSessionId | null,
): Promise<AgentSessionId | null> {
  const sendable = (await listAgentsForWorktree(worktreeId)).filter(
    (a) => a.status.kind === "running" || a.status.kind === "starting",
  );
  if (preferredId && sendable.some((a) => a.id === preferredId)) {
    return preferredId;
  }
  return sendable[0]?.id ?? null;
}

/// Backends whose CLI starts a session with `-- "<prompt>"` already
/// submitted (see Rust `supervisor::build_spawn_argv`).
export function acceptsPositionalPrompt(backend: AgentBackendKind): boolean {
  return backend === "claudeCode" || backend === "codex" || backend === "kiro";
}
