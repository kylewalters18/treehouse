import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ipc from "@/ipc/client";
import { useDiffsStore } from "./diffs";
import type { DiffSet } from "@/ipc/types";

vi.mock("@/ipc/client");
const ipcMocked = vi.mocked(ipc);

function diff(partial: Partial<DiffSet>): DiffSet {
  return {
    worktreeId: "wt-1",
    baseRef: "deadbeef",
    computedAt: BigInt(0) as unknown as DiffSet["computedAt"],
    files: [],
    stats: { filesChanged: 0, insertions: 0, deletions: 0 },
    truncated: false,
    ...partial,
  } as DiffSet;
}

describe("diffs store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useDiffsStore.getState().reset();
  });

  it("fetch populates byWorktree", async () => {
    const d = diff({
      files: [
        {
          path: "a.txt",
          status: { kind: "modified" },
          hunks: [],
          binary: false,
          insertions: 1,
          deletions: 0,
        },
      ],
      stats: { filesChanged: 1, insertions: 1, deletions: 0 },
    });
    ipcMocked.getDiff.mockResolvedValueOnce(d);
    await useDiffsStore.getState().fetch("wt-1");
    expect(useDiffsStore.getState().byWorktree["wt-1"]).toEqual(d);
    expect(useDiffsStore.getState().loading["wt-1"]).toBe(false);
  });

  it("fetch error populates the per-worktree error slot", async () => {
    ipcMocked.getDiff.mockRejectedValueOnce({ message: "no such worktree" });
    await useDiffsStore.getState().fetch("wt-1");
    expect(useDiffsStore.getState().error["wt-1"]).toBe("no such worktree");
  });

  it("set auto-selects the first file when none was selected", () => {
    const d = diff({
      files: [
        {
          path: "a.txt",
          status: { kind: "added" },
          hunks: [],
          binary: false,
          insertions: 0,
          deletions: 0,
        },
        {
          path: "b.txt",
          status: { kind: "modified" },
          hunks: [],
          binary: false,
          insertions: 0,
          deletions: 0,
        },
      ],
    });
    useDiffsStore.getState().set("wt-1", d);
    expect(useDiffsStore.getState().selectedFile["wt-1"]).toBe("a.txt");
  });

  it("set keeps the current selection if it's still in the new diff", () => {
    useDiffsStore.setState({ selectedFile: { "wt-1": "b.txt" } });
    const d = diff({
      files: [
        {
          path: "a.txt",
          status: { kind: "added" },
          hunks: [],
          binary: false,
          insertions: 0,
          deletions: 0,
        },
        {
          path: "b.txt",
          status: { kind: "modified" },
          hunks: [],
          binary: false,
          insertions: 0,
          deletions: 0,
        },
      ],
    });
    useDiffsStore.getState().set("wt-1", d);
    expect(useDiffsStore.getState().selectedFile["wt-1"]).toBe("b.txt");
  });

  it("set drops a selection that no longer exists, falling back to first file", () => {
    useDiffsStore.setState({ selectedFile: { "wt-1": "gone.txt" } });
    const d = diff({
      files: [
        {
          path: "still.txt",
          status: { kind: "modified" },
          hunks: [],
          binary: false,
          insertions: 0,
          deletions: 0,
        },
      ],
    });
    useDiffsStore.getState().set("wt-1", d);
    expect(useDiffsStore.getState().selectedFile["wt-1"]).toBe("still.txt");
  });

  it("setView persists view per worktree", () => {
    useDiffsStore.getState().setView("wt-1", "file");
    useDiffsStore.getState().setView("wt-2", "diff");
    expect(useDiffsStore.getState().view["wt-1"]).toBe("file");
    expect(useDiffsStore.getState().view["wt-2"]).toBe("diff");
  });

  it("reset clears all per-worktree maps", () => {
    useDiffsStore.setState({
      byWorktree: { "wt-1": diff({}) },
      loading: { "wt-1": true },
      error: { "wt-1": "x" },
      selectedFile: { "wt-1": "a" },
      view: { "wt-1": "file" },
    });
    useDiffsStore.getState().reset();
    const s = useDiffsStore.getState();
    expect(s.byWorktree).toEqual({});
    expect(s.loading).toEqual({});
    expect(s.error).toEqual({});
    expect(s.selectedFile).toEqual({});
    expect(s.view).toEqual({});
  });
});
