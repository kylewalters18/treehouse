import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ipc from "@/ipc/client";
import {
  formatBatchForAgent,
  formatCommentForAgent,
  useCommentsStore,
} from "./comments";
import type { Comment } from "@/ipc/types";

vi.mock("@/ipc/client");
const ipcMocked = vi.mocked(ipc);

function comment(partial: Partial<Comment>): Comment {
  return {
    id: "c-x",
    workspaceRoot: "/repo",
    branch: "agent/x",
    filePath: "src/foo.ts",
    line: 42,
    text: "look at this",
    createdAt: 0,
    resolvedAt: null,
    ...partial,
  } as Comment;
}

function freshState() {
  useCommentsStore.setState({
    items: [],
    queue: new Set(),
    loaded: false,
  });
}

describe("comments store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    freshState();
  });

  it("add persists and appends to items", async () => {
    const seed = comment({ id: "c-1" });
    ipcMocked.saveComments.mockImplementationOnce(async (cs) => cs);
    const c = await useCommentsStore.getState().add({
      workspaceRoot: seed.workspaceRoot,
      branch: seed.branch,
      filePath: seed.filePath,
      line: seed.line,
      text: seed.text,
    });
    expect(c).not.toBeNull();
    expect(useCommentsStore.getState().items).toHaveLength(1);
    expect(ipcMocked.saveComments).toHaveBeenCalled();
  });

  it("resolve marks resolvedAt and removes from queue", async () => {
    const c = comment({ id: "c-1" });
    useCommentsStore.setState({
      items: [c],
      queue: new Set(["c-1"]),
      loaded: true,
    });
    ipcMocked.saveComments.mockImplementationOnce(async (cs) => cs);
    await useCommentsStore.getState().resolve("c-1");
    const after = useCommentsStore.getState();
    expect(after.items[0].resolvedAt).not.toBeNull();
    expect(after.queue.has("c-1")).toBe(false);
  });

  it("toggleQueue adds and removes a comment id", () => {
    useCommentsStore.getState().toggleQueue("a");
    expect(useCommentsStore.getState().queue.has("a")).toBe(true);
    useCommentsStore.getState().toggleQueue("a");
    expect(useCommentsStore.getState().queue.has("a")).toBe(false);
  });

  it("remove drops from items and queue", async () => {
    const a = comment({ id: "a" });
    const b = comment({ id: "b" });
    useCommentsStore.setState({
      items: [a, b],
      queue: new Set(["a", "b"]),
      loaded: true,
    });
    ipcMocked.saveComments.mockImplementationOnce(async (cs) => cs);
    await useCommentsStore.getState().remove("a");
    const after = useCommentsStore.getState();
    expect(after.items.map((c) => c.id)).toEqual(["b"]);
    expect(after.queue.has("a")).toBe(false);
    expect(after.queue.has("b")).toBe(true);
  });

  it("clearQueueForBranch only drops matching comments", () => {
    const a = comment({ id: "a", workspaceRoot: "/r", branch: "agent/a" });
    const b = comment({ id: "b", workspaceRoot: "/r", branch: "agent/b" });
    useCommentsStore.setState({
      items: [a, b],
      queue: new Set(["a", "b"]),
      loaded: true,
    });
    useCommentsStore.getState().clearQueueForBranch("/r", "agent/a");
    const q = useCommentsStore.getState().queue;
    expect(q.has("a")).toBe(false);
    expect(q.has("b")).toBe(true);
  });

  it("load tolerates IPC failure", async () => {
    ipcMocked.listComments.mockRejectedValueOnce(new Error("disk"));
    await useCommentsStore.getState().load();
    expect(useCommentsStore.getState().loaded).toBe(true);
    expect(useCommentsStore.getState().items).toEqual([]);
  });
});

describe("formatCommentForAgent", () => {
  it("includes path:line header and a blank line before the body", () => {
    const out = formatCommentForAgent(
      comment({ filePath: "src/x.ts", line: 7, text: "fix this" }),
    );
    expect(out).toBe("Review comment on src/x.ts:7\n\nfix this\n");
  });
});

describe("formatBatchForAgent", () => {
  it("wraps every comment in [path:line] and separates with rules", () => {
    const out = formatBatchForAgent([
      comment({ id: "1", filePath: "a.ts", line: 1, text: "one" }),
      comment({ id: "2", filePath: "b.ts", line: 2, text: "two" }),
    ]);
    expect(out).toContain("Review comments (2):");
    expect(out).toContain("[a.ts:1]\none");
    expect(out).toContain("[b.ts:2]\ntwo");
    expect(out).toContain("\n---\n");
  });
});
