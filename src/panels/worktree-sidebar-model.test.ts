import { describe, it, expect } from "vitest";
import type {
  AgentActivity,
  Worktree,
  WorktreeActivity,
  WorktreeId,
} from "@/ipc/types";
import {
  inboxWorktrees,
  nextAcks,
  splitActive,
  statusCounts,
} from "./worktree-sidebar-model";

function wt(id: string): Worktree {
  return {
    id: id as WorktreeId,
    workspaceId: "ws" as Worktree["workspaceId"],
    path: `/r__worktrees/${id}`,
    branch: id,
    baseRef: "",
    baseBranch: "main",
    head: "",
    dirty: false,
    isMainClone: false,
  };
}

function act(
  entries: Record<string, Partial<WorktreeActivity> & { activity?: AgentActivity }>,
): Record<WorktreeId, WorktreeActivity> {
  const out: Record<WorktreeId, WorktreeActivity> = {};
  for (const [id, a] of Object.entries(entries)) {
    out[id as WorktreeId] = {
      worktreeId: id as WorktreeId,
      activity: "inactive",
      agentCount: 0,
      ahead: 0,
      behind: 0,
      dirty: false,
      merged: false,
      ...a,
    };
  }
  return out;
}

describe("inboxWorktrees", () => {
  it("puts blocked agents before finished ones and omits working", () => {
    const ws = [wt("a"), wt("b"), wt("c"), wt("d")];
    const a = act({
      a: { activity: "idle" },
      b: { activity: "working" },
      c: { activity: "needsAttention" },
      d: { activity: "inactive" },
    });
    expect(inboxWorktrees(ws, a, {}).map((w) => w.id)).toEqual(["c", "a"]);
  });

  it("hides acknowledged idle agents but never acknowledged blocked ones", () => {
    const ws = [wt("a"), wt("c")];
    const a = act({ a: { activity: "idle" }, c: { activity: "needsAttention" } });
    const acks = { a: true, c: true } as Record<WorktreeId, true>;
    expect(inboxWorktrees(ws, a, acks).map((w) => w.id)).toEqual(["c"]);
  });
});

describe("nextAcks", () => {
  it("acks the selected worktree when it's idle", () => {
    const a = act({ a: { activity: "idle" } });
    expect(nextAcks({}, a, "a" as WorktreeId)).toEqual({ a: true });
  });

  it("drops an ack once the agent leaves idle", () => {
    const a = act({ a: { activity: "working" } });
    expect(nextAcks({ a: true } as Record<WorktreeId, true>, a, null)).toEqual({});
  });

  it("returns the same object when nothing changed", () => {
    const prev = { a: true } as Record<WorktreeId, true>;
    const a = act({ a: { activity: "idle" } });
    expect(nextAcks(prev, a, "a" as WorktreeId)).toBe(prev);
  });
});

describe("splitActive", () => {
  it("keeps input order and demotes merged branches", () => {
    const ws = [wt("a"), wt("b"), wt("c"), wt("d"), wt("e")];
    const a = act({
      a: { ahead: 2 },
      b: {},
      c: { activity: "working" },
      d: { ahead: 3, merged: true },
      e: { dirty: true },
    });
    const { active, inactive } = splitActive(ws, a);
    expect(active.map((w) => w.id)).toEqual(["a", "c", "e"]);
    expect(inactive.map((w) => w.id)).toEqual(["b", "d"]);
  });
});

describe("statusCounts", () => {
  it("tallies live agent states per repo", () => {
    const ws = [wt("a"), wt("b"), wt("c"), wt("d")];
    const a = act({
      a: { activity: "working" },
      b: { activity: "working" },
      c: { activity: "needsAttention" },
    });
    expect(statusCounts(ws, a)).toEqual({
      working: 2,
      idle: 0,
      needsAttention: 1,
    });
  });
});
