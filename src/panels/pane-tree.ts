import type { TerminalId } from "@/ipc/types";

/// How a single terminal pane is launched. `open` starts a fresh shell;
/// `attach` reattaches to an existing PTY discovered on worktree visit.
export type PaneMode =
  | { kind: "open" }
  | { kind: "attach"; terminalId: TerminalId };

/// A leaf is one PTY/xterm. A split holds two children (a binary tree),
/// arranged side-by-side (`horizontal`) or stacked (`vertical`) to match
/// react-resizable-panels' direction names.
export type PaneLeaf = {
  kind: "leaf";
  localId: string;
  mode: PaneMode;
};
export type PaneSplit = {
  kind: "split";
  /// Stable identity used as `autoSaveId` on the rendered PanelGroup so
  /// resize sizes survive worktree switches (the whole TerminalTabs
  /// subtree unmounts on switch). Without this, panels reset to
  /// defaultSize on every visit and the resulting term.resize triggers
  /// SIGWINCH → zsh redraws with PROMPT_SP (`%` artefacts).
  id: string;
  direction: "horizontal" | "vertical";
  a: PaneNode;
  b: PaneNode;
};
export type PaneNode = PaneLeaf | PaneSplit;

export function makeLeaf(mode: PaneMode): PaneLeaf {
  return { kind: "leaf", localId: crypto.randomUUID(), mode };
}

/// Replace the leaf with `targetId` by a split that has the original on
/// one side and `newLeaf` on the other. Order is preserved so split-right
/// and split-below put the new pane on the right / bottom respectively.
export function splitLeaf(
  tree: PaneNode,
  targetId: string,
  direction: "horizontal" | "vertical",
  newLeaf: PaneLeaf,
): PaneNode {
  if (tree.kind === "leaf") {
    if (tree.localId === targetId) {
      return {
        kind: "split",
        id: crypto.randomUUID(),
        direction,
        a: tree,
        b: newLeaf,
      };
    }
    return tree;
  }
  return {
    ...tree,
    a: splitLeaf(tree.a, targetId, direction, newLeaf),
    b: splitLeaf(tree.b, targetId, direction, newLeaf),
  };
}

/// Remove the leaf with `targetId`. When a split's child becomes empty,
/// the surviving child takes the split's place — so closing one of two
/// panes collapses the split rather than leaving an empty slot. Returns
/// `null` if the only remaining leaf is the one being closed (the caller
/// should drop the whole tab in that case).
export function closeLeaf(tree: PaneNode, targetId: string): PaneNode | null {
  if (tree.kind === "leaf") {
    return tree.localId === targetId ? null : tree;
  }
  const a = closeLeaf(tree.a, targetId);
  const b = closeLeaf(tree.b, targetId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...tree, a, b };
}

export function findLeaf(tree: PaneNode, id: string): PaneLeaf | null {
  if (tree.kind === "leaf") return tree.localId === id ? tree : null;
  return findLeaf(tree.a, id) ?? findLeaf(tree.b, id);
}

export function leaves(tree: PaneNode): PaneLeaf[] {
  if (tree.kind === "leaf") return [tree];
  return [...leaves(tree.a), ...leaves(tree.b)];
}

export function firstLeaf(tree: PaneNode): PaneLeaf {
  if (tree.kind === "leaf") return tree;
  return firstLeaf(tree.a);
}

/// Replace one leaf's `mode` (e.g. flip open → attach once a session id
/// is known) without otherwise reshaping the tree.
export function setLeafMode(
  tree: PaneNode,
  leafId: string,
  mode: PaneMode,
): PaneNode {
  if (tree.kind === "leaf") {
    return tree.localId === leafId ? { ...tree, mode } : tree;
  }
  return {
    ...tree,
    a: setLeafMode(tree.a, leafId, mode),
    b: setLeafMode(tree.b, leafId, mode),
  };
}
