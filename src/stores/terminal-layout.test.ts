import { describe, it, expect } from "vitest";
import { makeLeaf, splitLeaf, leaves, type PaneLeaf } from "@/panels/pane-tree";
import {
  emptyLayout,
  reconcileLayout,
  type TerminalTab,
} from "./terminal-layout";
import type { TerminalId, TerminalSession, WorktreeId } from "@/ipc/types";

const SESSION_ID = (s: string): TerminalId => s as TerminalId;
const WT_ID = (s: string): WorktreeId => s as WorktreeId;

function fakeSession(id: string): TerminalSession {
  return {
    id: SESSION_ID(id),
    worktreeId: WT_ID("w1"),
    shell: "zsh",
    cols: 80,
    rows: 24,
    alive: true,
  };
}

function attachLeaf(id: string): PaneLeaf {
  return makeLeaf({ kind: "attach", terminalId: SESSION_ID(id) });
}

describe("reconcileLayout", () => {
  it("preserves a split across navigate-away/back when both PTYs are still running (regression for the splits-become-individual-tabs bug)", () => {
    const a = attachLeaf("t1");
    const b = attachLeaf("t2");
    const stored: ReturnType<typeof emptyLayout> = {
      counter: 2,
      activeTabId: "tab-1",
      tabs: [
        {
          localId: "tab-1",
          label: "zsh 1",
          tree: splitLeaf(a, a.localId, "horizontal", b),
          activeLeafId: b.localId,
        },
      ],
    };

    const next = reconcileLayout(stored, [fakeSession("t1"), fakeSession("t2")]);

    expect(next.tabs).toHaveLength(1);
    expect(next.tabs[0].tree.kind).toBe("split");
    expect(leaves(next.tabs[0].tree).map((l) => l.localId).sort()).toEqual(
      [a.localId, b.localId].sort(),
    );
    expect(next.activeTabId).toBe("tab-1");
  });

  it("prunes a dead leaf from a split, collapsing the parent into the survivor", () => {
    const a = attachLeaf("t1");
    const b = attachLeaf("t2");
    const stored = {
      counter: 2,
      activeTabId: "tab-1",
      tabs: [
        {
          localId: "tab-1",
          label: "zsh 1",
          tree: splitLeaf(a, a.localId, "horizontal", b),
          activeLeafId: b.localId,
        } satisfies TerminalTab,
      ],
    };

    // t2 went away while we were on another worktree.
    const next = reconcileLayout(stored, [fakeSession("t1")]);

    expect(next.tabs).toHaveLength(1);
    expect(next.tabs[0].tree.kind).toBe("leaf");
    if (next.tabs[0].tree.kind !== "leaf") throw new Error();
    expect(next.tabs[0].tree.localId).toBe(a.localId);
    // activeLeafId pointed at b (now gone) → falls back to the survivor.
    expect(next.tabs[0].activeLeafId).toBe(a.localId);
  });

  it("drops a tab whose only leaf died", () => {
    const a = attachLeaf("t1");
    const stored = {
      counter: 1,
      activeTabId: "tab-1",
      tabs: [
        {
          localId: "tab-1",
          label: "zsh 1",
          tree: a,
          activeLeafId: a.localId,
        } satisfies TerminalTab,
      ],
    };

    const next = reconcileLayout(stored, []);

    expect(next.tabs).toHaveLength(0);
    expect(next.activeTabId).toBeNull();
  });

  it("appends a fresh tab for a running PTY the layout doesn't know about", () => {
    const a = attachLeaf("t1");
    const stored = {
      counter: 1,
      activeTabId: "tab-1",
      tabs: [
        {
          localId: "tab-1",
          label: "zsh 1",
          tree: a,
          activeLeafId: a.localId,
        } satisfies TerminalTab,
      ],
    };

    const next = reconcileLayout(stored, [fakeSession("t1"), fakeSession("t2")]);

    expect(next.tabs).toHaveLength(2);
    // Counter advanced for the new tab's label.
    expect(next.tabs[1].label).toBe("zsh 2");
    expect(next.counter).toBe(2);
  });

  it("seeds nothing when there's no stored layout and no running PTYs (caller seeds a fresh tab)", () => {
    const next = reconcileLayout(emptyLayout(), []);
    expect(next.tabs).toHaveLength(0);
    expect(next.counter).toBe(0);
  });
});
