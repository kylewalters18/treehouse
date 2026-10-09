import { describe, expect, it } from "vitest";
import type {
  TerminalCommand,
  TerminalId,
  WorktreeActivity,
  WorktreeId,
} from "@/ipc/types";
import { makeLeaf } from "@/panels/pane-tree";
import { finishedSince, tabForTerminal } from "./command-alerts";

const T = "t1" as TerminalId;
const W = "w1" as WorktreeId;

function snapshot(...commands: TerminalCommand[]): Record<WorktreeId, WorktreeActivity> {
  return {
    [W]: {
      worktreeId: W,
      activity: "inactive",
      agentCount: 0,
      ahead: 0,
      behind: 0,
      dirty: false,
      changedFiles: 0,
      commands,
      merged: false,
    },
  };
}

function cmd(startedAt: number, finishedAt: number | null): TerminalCommand {
  return { terminalId: T, command: "docker build .", startedAt, finishedAt, exitCode: 0 };
}

describe("finishedSince", () => {
  it("reports a long command that was seen running", () => {
    const first = finishedSince(new Map(), snapshot(cmd(0, null)));
    expect(first.finished).toEqual([]);
    const second = finishedSince(first.running, snapshot(cmd(0, 45_000)));
    expect(second.finished.map((f) => f.worktreeId)).toEqual([W]);
    expect(second.running.size).toBe(0);
  });

  it("skips short commands", () => {
    const { running } = finishedSince(new Map(), snapshot(cmd(0, null)));
    expect(finishedSince(running, snapshot(cmd(0, 5_000))).finished).toEqual([]);
  });

  it("skips commands never seen running", () => {
    expect(finishedSince(new Map(), snapshot(cmd(0, 60_000))).finished).toEqual([]);
  });

  it("reports each finish once", () => {
    const { running } = finishedSince(new Map(), snapshot(cmd(0, null)));
    const once = finishedSince(running, snapshot(cmd(0, 60_000)));
    expect(finishedSince(once.running, snapshot(cmd(0, 60_000))).finished).toEqual([]);
  });

  it("doesn't confuse a later command in the same terminal", () => {
    const { running } = finishedSince(new Map(), snapshot(cmd(0, null)));
    expect(
      finishedSince(running, snapshot(cmd(70_000, 120_000))).finished,
    ).toEqual([]);
  });
});

describe("tabForTerminal", () => {
  it("finds the tab holding the terminal", () => {
    const leaf = makeLeaf({ kind: "attach", terminalId: T });
    const other = makeLeaf({ kind: "open" });
    const layout = {
      tabs: [
        { localId: "a", label: "zsh 1", tree: other, activeLeafId: other.localId },
        { localId: "b", label: "zsh 2", tree: leaf, activeLeafId: leaf.localId },
      ],
      activeTabId: "a",
      counter: 2,
    };
    expect(tabForTerminal(layout, T)).toBe("b");
    expect(tabForTerminal(layout, "nope" as TerminalId)).toBeNull();
  });
});
