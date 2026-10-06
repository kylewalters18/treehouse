import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ipc from "@/ipc/client";
import {
  anchorLabel,
  commentStatus,
  formatBatchForAgent,
  formatCommentForAgent,
  formatReviewForAgent,
  reviewKey,
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
    endLine: null,
    side: "head",
    commit: null,
    text: "look at this",
    createdAt: 0,
    sentAt: null,
    resolvedAt: null,
    ...partial,
  } as Comment;
}

function freshState() {
  useCommentsStore.setState({
    items: [],
    includedThreads: {},
    summaries: {},
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

  it("new comments start pending", async () => {
    ipcMocked.saveComments.mockImplementationOnce(async (cs) => cs);
    const c = await useCommentsStore.getState().add({
      workspaceRoot: "/r",
      branch: "b",
      filePath: "a.ts",
      line: 1,
      text: "x",
    });
    expect(commentStatus(c!)).toBe("pending");
  });

  it("markSent moves only the named comments to sent", async () => {
    useCommentsStore.setState({
      items: [comment({ id: "a" }), comment({ id: "b" })],
      loaded: true,
    });
    ipcMocked.saveComments.mockImplementationOnce(async (cs) => cs);
    await useCommentsStore.getState().markSent(["a"]);
    const [a, b] = useCommentsStore.getState().items;
    expect(commentStatus(a)).toBe("sent");
    expect(commentStatus(b)).toBe("pending");
  });

  it("resolve wins over sent; unresolve returns to sent", async () => {
    useCommentsStore.setState({
      items: [comment({ id: "a", sentAt: 5 })],
      loaded: true,
    });
    ipcMocked.saveComments.mockImplementation(async (cs) => cs);
    await useCommentsStore.getState().resolve("a");
    expect(commentStatus(useCommentsStore.getState().items[0])).toBe("resolved");
    await useCommentsStore.getState().unresolve("a");
    expect(commentStatus(useCommentsStore.getState().items[0])).toBe("sent");
  });

  it("markPending clears both sent and resolved", async () => {
    useCommentsStore.setState({
      items: [comment({ id: "a", sentAt: 5, resolvedAt: 6 })],
      loaded: true,
    });
    ipcMocked.saveComments.mockImplementationOnce(async (cs) => cs);
    await useCommentsStore.getState().markPending("a");
    expect(commentStatus(useCommentsStore.getState().items[0])).toBe("pending");
  });

  it("remove drops the comment", async () => {
    useCommentsStore.setState({
      items: [comment({ id: "a" }), comment({ id: "b" })],
      loaded: true,
    });
    ipcMocked.saveComments.mockImplementationOnce(async (cs) => cs);
    await useCommentsStore.getState().remove("a");
    expect(useCommentsStore.getState().items.map((c) => c.id)).toEqual(["b"]);
  });

  it("toggleThread and clearBatch are scoped per branch", () => {
    const ka = reviewKey("/r", "a");
    const kb = reviewKey("/r", "b");
    const st = useCommentsStore.getState();
    st.toggleThread(ka, "t1");
    st.toggleThread(kb, "t2");
    st.setSummary(ka, "focus on errors");
    expect(useCommentsStore.getState().includedThreads[ka]).toEqual(["t1"]);
    useCommentsStore.getState().toggleThread(ka, "t1");
    expect(useCommentsStore.getState().includedThreads[ka]).toEqual([]);
    useCommentsStore.getState().clearBatch(ka);
    const after = useCommentsStore.getState();
    expect(after.summaries[ka]).toBeUndefined();
    expect(after.includedThreads[kb]).toEqual(["t2"]);
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

describe("comment anchors", () => {
  it("labels ranges and whole-file comments for the UI", () => {
    expect(anchorLabel(comment({ filePath: "a.rs", line: 3, endLine: 8 }))).toBe(
      "a.rs:3–8",
    );
    expect(anchorLabel(comment({ filePath: "a.rs", line: 0 }))).toBe("a.rs");
  });

  it("tells the agent about ranges, removed lines and whole files", () => {
    expect(
      formatCommentForAgent(comment({ filePath: "a.rs", line: 3, endLine: 8, text: "t" })),
    ).toBe("Review comment on a.rs:3-8\n\nt\n");
    expect(
      formatCommentForAgent(comment({ filePath: "a.rs", line: 5, side: "base", text: "t" })),
    ).toContain("a.rs:5 (removed line — numbering is from the diff base)");
    expect(
      formatBatchForAgent([comment({ filePath: "a.rs", line: 0, text: "t" })]),
    ).toContain("[a.rs (whole file)]\nt");
  });

  it("names the commit for comments made on a single commit's diff", () => {
    const commit = "3c611bc0123456789abcdef0123456789abcdef0";
    expect(
      formatCommentForAgent(comment({ filePath: "a.rs", line: 5, commit, text: "t" })),
    ).toContain(
      "a.rs:5 (in commit 3c611bc — numbering is from that commit's version of the file)",
    );
    expect(
      formatCommentForAgent(
        comment({ filePath: "a.rs", line: 5, endLine: 6, side: "base", commit, text: "t" }),
      ),
    ).toContain("a.rs:5-6 (lines removed in commit 3c611bc — numbering is from its parent, 3c611bc^)");
    expect(
      formatCommentForAgent(comment({ filePath: "a.rs", line: 0, commit, text: "t" })),
    ).toContain("a.rs (whole file, as changed in commit 3c611bc)");
  });
});

describe("formatReviewForAgent", () => {
  it("puts the summary first, then comments, then threads", () => {
    const out = formatReviewForAgent(
      "  focus on errors ",
      [comment({ filePath: "a.ts", line: 1, text: "one" })],
      ["MR review thread on b.ts:2:\n\n@kim: two\n"],
    );
    const iSummary = out.indexOf("focus on errors");
    const iComment = out.indexOf("[a.ts:1]");
    const iThread = out.indexOf("MR review thread");
    expect(iSummary).toBe(0);
    expect(iComment).toBeGreaterThan(iSummary);
    expect(iThread).toBeGreaterThan(iComment);
  });

  it("omits an empty summary", () => {
    const out = formatReviewForAgent("", [comment({ text: "one" })], []);
    expect(out.startsWith("Review comments (1):")).toBe(true);
  });
});
