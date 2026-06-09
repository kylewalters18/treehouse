import type { ForgeNote, ForgeThread } from "@/ipc/types";

/// Format a forge MR review thread or a single note into a prompt for an
/// agent. Kept pure (no store/IPC) so it's unit-testable and reusable. The
/// inline anchor (`path:line`) is included when present so the agent knows
/// where in the diff the feedback lands.

/// `path:line` for an inline note, or null for a general (non-anchored) one.
function anchorOfNote(note: ForgeNote): string | null {
  const p = note.position;
  if (p?.newPath != null && p.newLine != null) {
    return `${p.newPath}:${p.newLine}`;
  }
  return null;
}

/// First inline-anchored note in a thread gives the thread its location.
function anchorOfThread(thread: ForgeThread): string | null {
  for (const n of thread.notes) {
    const a = anchorOfNote(n);
    if (a) return a;
  }
  return null;
}

function note(n: ForgeNote): string {
  return `@${n.author}: ${n.body.trim()}`;
}

export function formatThreadForAgent(thread: ForgeThread): string {
  const anchor = anchorOfThread(thread);
  const head = anchor ? `MR review thread on ${anchor}:` : "MR review thread:";
  const body = thread.notes.map(note).join("\n\n");
  return `${head}\n\n${body}\n\nPlease address this review thread.\n`;
}

export function formatNoteForAgent(n: ForgeNote): string {
  const anchor = anchorOfNote(n);
  const head = anchor ? `MR review comment on ${anchor}:` : "MR review comment:";
  return `${head}\n\n${note(n)}\n\nPlease address this comment.\n`;
}
