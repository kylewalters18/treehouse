import { describe, it, expect } from "vitest";
import type { AgentOverview } from "@/ipc/types";
import {
  boardOrder,
  columnOf,
  fallbackLabels,
  formatAge,
  groupBoard,
  summaryOf,
} from "./agent-board-model";

function ov(
  id: string,
  over: Partial<AgentOverview> & {
    worktreeId?: string;
    startedAt?: number;
    argv?: string[];
    backend?: AgentOverview["session"]["backend"];
  } = {},
): AgentOverview {
  const { worktreeId, startedAt, argv, backend, ...rest } = over;
  return {
    session: {
      id,
      worktreeId: worktreeId ?? "wt-1",
      backend: backend ?? "claudeCode",
      argv: argv ?? ["claude"],
      startedAt: BigInt(startedAt ?? 0),
      cols: 80,
      rows: 24,
      status: { kind: "running" },
      resumed: false,
    },
    activity: "idle",
    changedAt: 1000,
    title: null,
    task: null,
    currentTool: null,
    lastMessage: null,
    pending: null,
    canAnswerInline: false,
    diffStats: null,
    ...rest,
  };
}

describe("columnOf", () => {
  it("maps activity to columns", () => {
    expect(columnOf(ov("a", { activity: "needsAttention" }), {})).toBe("blocked");
    expect(columnOf(ov("a", { activity: "working" }), {})).toBe("working");
    expect(columnOf(ov("a", { activity: "inactive" }), {})).toBe("quiet");
  });

  it("an idle turn is ready to review until seen after it ended", () => {
    const o = ov("a", { activity: "idle", changedAt: 1000 });
    expect(columnOf(o, {})).toBe("review");
    expect(columnOf(o, { a: 999 })).toBe("review");
    expect(columnOf(o, { a: 1000 })).toBe("quiet");
  });
});

describe("groupBoard", () => {
  it("orders longest-waiting first, quiet most-recent first", () => {
    const g = groupBoard(
      [
        ov("b2", { activity: "needsAttention", changedAt: 20 }),
        ov("b1", { activity: "needsAttention", changedAt: 10 }),
        ov("q1", { activity: "inactive", changedAt: 10 }),
        ov("q2", { activity: "inactive", changedAt: 20 }),
        ov("w1", { activity: "working", changedAt: 5 }),
      ],
      {},
    );
    expect(g.blocked.map((o) => o.session.id)).toEqual(["b1", "b2"]);
    expect(g.quiet.map((o) => o.session.id)).toEqual(["q2", "q1"]);
    expect(boardOrder(g).map((o) => o.session.id)).toEqual([
      "b1",
      "b2",
      "w1",
      "q2",
      "q1",
    ]);
  });
});

describe("fallbackLabels", () => {
  it("numbers per worktree and backend in start order, with --agent", () => {
    const labels = fallbackLabels([
      ov("c2", { startedAt: 2 }),
      ov("c1", { startedAt: 1 }),
      ov("x1", { startedAt: 3, backend: "codex", argv: ["codex"] }),
      ov("c3", { startedAt: 4, argv: ["claude", "--agent", "Plan"] }),
      ov("o1", { startedAt: 5, worktreeId: "wt-2" }),
    ]);
    expect(labels).toEqual({
      c1: "Claude 1",
      c2: "Claude 2",
      x1: "Codex 1",
      c3: "Claude 3 (Plan)",
      o1: "Claude 1",
    });
  });
});

describe("summaryOf", () => {
  it("working shows the current tool, never the task", () => {
    expect(summaryOf(ov("a", { activity: "working", task: "t", currentTool: "Bash: ls" }))).toBe("Bash: ls");
    expect(summaryOf(ov("a", { activity: "working", task: "t" }))).toBeNull();
  });

  it("blocked on permission has no summary; on input shows the message", () => {
    const perm = ov("a", {
      activity: "needsAttention",
      task: "fix it",
      pending: { kind: "permission", toolName: "Bash", detail: "ls" },
    });
    expect(summaryOf(perm)).toBeNull();
    const input = ov("a", {
      activity: "needsAttention",
      pending: { kind: "input", message: "Pick one" },
    });
    expect(summaryOf(input)).toBe("Pick one");
    expect(summaryOf(ov("a", { activity: "needsAttention" }))).toBe("Waiting for your reply");
  });

  it("idle shows the final message", () => {
    expect(summaryOf(ov("a", { activity: "idle", lastMessage: "Done", task: "t" }))).toBe("Done");
    expect(summaryOf(ov("a", { activity: "idle", task: "t" }))).toBeNull();
  });
});

describe("formatAge", () => {
  it("formats compact ages", () => {
    expect(formatAge(0, 3_000)).toBe("now");
    expect(formatAge(0, 42_000)).toBe("42s");
    expect(formatAge(0, 6 * 60_000)).toBe("6m");
    expect(formatAge(0, 3 * 3_600_000)).toBe("3h");
    expect(formatAge(0, 72 * 3_600_000)).toBe("3d");
  });
});
