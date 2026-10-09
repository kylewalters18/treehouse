/// Toast when a long terminal command finishes somewhere you aren't
/// looking. Watches the activity snapshot the sidebar keeps fresh; see
/// `finishedSince` for which commands count.

import { useEffect } from "react";
import type { TerminalCommand, WorktreeId } from "@/ipc/types";
import { useActivityStore } from "@/stores/activity";
import { useTerminalLayoutStore } from "@/stores/terminal-layout";
import { useToastsStore } from "@/stores/toasts";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import {
  finishedSince,
  tabForTerminal,
  type SeenRunning,
} from "@/lib/command-alerts";
import { commandLabel, formatElapsed } from "@/lib/terminal-command";

/// Toasts stay this long while the app has focus. When it doesn't, they
/// stay until dismissed so they're there when you come back.
const FOCUSED_TOAST_MS = 10_000;

export function CommandAlerts() {
  useEffect(() => {
    let seen: SeenRunning = new Map();
    const check = (byWorktree: ReturnType<typeof useActivityStore.getState>["byWorktree"]) => {
      const { finished, running } = finishedSince(seen, byWorktree);
      seen = running;
      for (const f of finished) {
        if (!isWatching(f.worktreeId, f.command)) notify(f.worktreeId, f.command);
      }
    };
    check(useActivityStore.getState().byWorktree);
    return useActivityStore.subscribe((s) => check(s.byWorktree));
  }, []);
  return null;
}

/// The window has focus and the command's terminal tab is on screen.
function isWatching(worktreeId: WorktreeId, c: TerminalCommand): boolean {
  if (!document.hasFocus()) return false;
  const ui = useUiStore.getState();
  if (ui.selectedWorktreeId !== worktreeId) return false;
  if (ui.bottomPaneTab !== "terminal" || ui.focusMode) return false;
  const layout = useTerminalLayoutStore.getState().layouts[worktreeId];
  return layout?.activeTabId === tabForTerminal(layout, c.terminalId);
}

function notify(worktreeId: WorktreeId, c: TerminalCommand) {
  const branch = useWorktreesStore
    .getState()
    .worktrees.find((w) => w.id === worktreeId)?.branch;
  const label = commandLabel(c.command) || "Command";
  const took = formatElapsed((c.finishedAt ?? c.startedAt) - c.startedAt);
  const failed = c.exitCode != null && c.exitCode !== 0;
  useToastsStore.getState().push({
    kind: c.exitCode == null ? "info" : failed ? "error" : "success",
    title: failed ? `${label} failed (exit ${c.exitCode})` : `${label} finished`,
    body: [branch, took].filter(Boolean).join(" · "),
    action: { label: "Show terminal", run: () => showTerminal(worktreeId, c) },
    durationMs: document.hasFocus() ? FOCUSED_TOAST_MS : null,
  });
}

function showTerminal(worktreeId: WorktreeId, c: TerminalCommand) {
  const ui = useUiStore.getState();
  ui.selectWorktree(worktreeId);
  ui.setBottomPaneTab("terminal");
  if (ui.focusMode) ui.setFocusMode(false);
  const layouts = useTerminalLayoutStore.getState();
  const tabId = tabForTerminal(layouts.layouts[worktreeId], c.terminalId);
  if (tabId) {
    layouts.updateLayout(worktreeId, (prev) => ({ ...prev, activeTabId: tabId }));
  }
}
