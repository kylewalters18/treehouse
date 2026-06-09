import { agentWrite, listAgentsForWorktree } from "@/ipc/client";
import type { AgentSessionId, WorktreeId } from "@/ipc/types";

// Bracketed-paste sequences — tells a TTY REPL (Claude Code, etc.) that the
// following bytes are a single paste, so embedded newlines aren't each
// interpreted as "submit". Ending with `\r` triggers the actual submit, the
// same byte the Enter key sends in a cooked-mode terminal.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export async function pasteAndSubmit(
  agentId: AgentSessionId,
  text: string,
): Promise<void> {
  const enc = new TextEncoder();
  await agentWrite(agentId, enc.encode(PASTE_START + text + PASTE_END + "\r"));
}

/// Pick a sendable agent for a worktree: prefer `preferredId` (typically the
/// active tab) when it's still running, else the first running/starting agent.
/// Returns null when the worktree has no live agent to send to. Mirrors the
/// selection the Send-queue dropdown does, for callers (e.g. the Review tab)
/// that send directly without showing a picker.
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
