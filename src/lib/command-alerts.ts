/// Which terminal commands just finished and deserve a toast. Pure so the
/// rules are testable; `CommandAlerts` wires it to the activity store.

import type {
  TerminalCommand,
  TerminalId,
  WorktreeActivity,
  WorktreeId,
} from "@/ipc/types";
import type { WorktreeTerminalLayout } from "@/stores/terminal-layout";
import { leaves } from "@/panels/pane-tree";

/// Commands shorter than this finish without a toast.
export const ALERT_AFTER_MS = 30_000;

/// Running commands seen so far: terminal → its command's `startedAt`.
export type SeenRunning = Map<TerminalId, number>;

export type FinishedCommand = {
  worktreeId: WorktreeId;
  command: TerminalCommand;
};

/// Diff a fresh activity snapshot against what was running last time.
/// Returns long commands that went from running to finished, and the new
/// running set. A command first seen already finished (app start, repo
/// just opened) is never reported.
export function finishedSince(
  seen: SeenRunning,
  byWorktree: Record<WorktreeId, WorktreeActivity>,
): { finished: FinishedCommand[]; running: SeenRunning } {
  const finished: FinishedCommand[] = [];
  const running: SeenRunning = new Map();
  for (const a of Object.values(byWorktree)) {
    for (const c of a.commands ?? []) {
      if (c.finishedAt == null) {
        running.set(c.terminalId, c.startedAt);
      } else if (
        seen.get(c.terminalId) === c.startedAt &&
        c.finishedAt - c.startedAt >= ALERT_AFTER_MS
      ) {
        finished.push({ worktreeId: a.worktreeId, command: c });
      }
    }
  }
  return { finished, running };
}

/// The tab (local id) whose panes include `terminalId`.
export function tabForTerminal(
  layout: WorktreeTerminalLayout | undefined,
  terminalId: TerminalId,
): string | null {
  const tab = layout?.tabs.find((t) =>
    leaves(t.tree).some(
      (l) => l.mode.kind === "attach" && l.mode.terminalId === terminalId,
    ),
  );
  return tab?.localId ?? null;
}
