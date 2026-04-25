import { create } from "zustand";
import type { TerminalId, TerminalSession, WorktreeId } from "@/ipc/types";
import {
  closeLeaf,
  firstLeaf,
  leaves,
  makeLeaf,
  type PaneNode,
} from "@/panels/pane-tree";

/// One terminal tab — a binary tree of panes. Mirrors the local Tab
/// type the component used before persistence; lives here so it
/// survives `<TerminalTabs key={worktreeId}>` unmounts on worktree
/// switch.
export type TerminalTab = {
  localId: string;
  label: string;
  tree: PaneNode;
  activeLeafId: string;
};

export type WorktreeTerminalLayout = {
  tabs: TerminalTab[];
  activeTabId: string | null;
  /// Monotonic per-worktree counter for `zsh N` labels. Persisted so
  /// labels stay stable across worktree switches and don't reset every
  /// time you come back.
  counter: number;
};

/// Stable identity for "we have no layout for this worktree yet" — used
/// as the selector fallback so zustand doesn't see a fresh ref every
/// render and remount the subscriber forever (blank-screen on first
/// worktree visit).
export const EMPTY_LAYOUT: WorktreeTerminalLayout = Object.freeze({
  tabs: [],
  activeTabId: null,
  counter: 0,
}) as WorktreeTerminalLayout;

/// Mutable factory for code paths that need to seed a layout from
/// scratch (e.g. `updateLayout` callers that fall back when no entry
/// exists yet). Don't use in selectors — see `EMPTY_LAYOUT`.
export function emptyLayout(): WorktreeTerminalLayout {
  return { tabs: [], activeTabId: null, counter: 0 };
}

type State = {
  layouts: Record<WorktreeId, WorktreeTerminalLayout>;
  setLayout: (worktreeId: WorktreeId, layout: WorktreeTerminalLayout) => void;
  updateLayout: (
    worktreeId: WorktreeId,
    fn: (prev: WorktreeTerminalLayout) => WorktreeTerminalLayout,
  ) => void;
  reset: () => void;
};

export const useTerminalLayoutStore = create<State>((set) => ({
  layouts: {},
  setLayout(worktreeId, layout) {
    set((s) => ({ layouts: { ...s.layouts, [worktreeId]: layout } }));
  },
  updateLayout(worktreeId, fn) {
    set((s) => ({
      layouts: {
        ...s.layouts,
        [worktreeId]: fn(s.layouts[worktreeId] ?? emptyLayout()),
      },
    }));
  },
  reset() {
    set({ layouts: {} });
  },
}));

/// Pull the live `terminalId`s out of a tree (only `attach`-mode leaves
/// know their server id; freshly-opened leaves haven't been told yet).
function attachedTerminalIds(tree: PaneNode): Set<TerminalId> {
  const out = new Set<TerminalId>();
  for (const l of leaves(tree)) {
    if (l.mode.kind === "attach") out.add(l.mode.terminalId);
  }
  return out;
}

/// Drop leaves from a tree whose `attach`-mode terminalId is no longer
/// in `runningIds`. Leaves still in `open` mode (haven't received their
/// session id yet) are kept — they're in flight on the Rust side.
function pruneDeadLeaves(
  tree: PaneNode,
  runningIds: Set<TerminalId>,
): PaneNode | null {
  let out: PaneNode | null = tree;
  for (const l of leaves(tree)) {
    if (l.mode.kind === "attach" && !runningIds.has(l.mode.terminalId)) {
      out = out === null ? null : closeLeaf(out, l.localId);
    }
  }
  return out;
}

/// Take what we last knew about this worktree's layout and bring it in
/// line with the actual running PTYs:
/// - Leaves whose terminalId is gone get pruned (their split parents
///   collapse into the surviving sibling).
/// - Tabs that empty out get dropped.
/// - PTYs the layout doesn't reference get appended as fresh single-leaf
///   tabs (someone else opened them, or we lost the layout).
/// `counter` only goes up, so labels stay stable across reconciles.
export function reconcileLayout(
  stored: WorktreeTerminalLayout,
  running: TerminalSession[],
): WorktreeTerminalLayout {
  const runningIds = new Set<TerminalId>(running.map((s) => s.id));
  const reconciledTabs: TerminalTab[] = [];

  for (const tab of stored.tabs) {
    const tree = pruneDeadLeaves(tab.tree, runningIds);
    if (tree === null) continue;
    const stillHas = (id: string) =>
      leaves(tree).some((l) => l.localId === id);
    reconciledTabs.push({
      ...tab,
      tree,
      activeLeafId: stillHas(tab.activeLeafId)
        ? tab.activeLeafId
        : firstLeaf(tree).localId,
    });
  }

  const known = new Set<TerminalId>();
  for (const tab of reconciledTabs) {
    for (const id of attachedTerminalIds(tab.tree)) known.add(id);
  }

  let counter = stored.counter;
  for (const session of running) {
    if (known.has(session.id)) continue;
    counter += 1;
    const leaf = makeLeaf({ kind: "attach", terminalId: session.id });
    reconciledTabs.push({
      localId: crypto.randomUUID(),
      label: `zsh ${counter}`,
      tree: leaf,
      activeLeafId: leaf.localId,
    });
  }

  let activeTabId = stored.activeTabId;
  if (activeTabId === null || !reconciledTabs.some((t) => t.localId === activeTabId)) {
    activeTabId = reconciledTabs[reconciledTabs.length - 1]?.localId ?? null;
  }

  return { tabs: reconciledTabs, activeTabId, counter };
}
