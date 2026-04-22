import { agentWrite } from "@/ipc/client";
import type { AgentSessionId } from "@/ipc/types";

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
