import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ipc from "@/ipc/client";
import { useWorktreesStore } from "./worktrees";
import { useToastsStore } from "./toasts";
import type { Worktree } from "@/ipc/types";

vi.mock("@/ipc/client");
const ipcMocked = vi.mocked(ipc);

function wt(partial: Partial<Worktree>): Worktree {
  return {
    id: "wt-x",
    workspaceId: "ws-1",
    path: "/tmp/repo__worktrees/x",
    branch: "agent/x",
    baseRef: "deadbeef",
    head: "deadbeef",
    dirty: false,
    isMainClone: false,
    ...partial,
  } as Worktree;
}

function freshState() {
  useWorktreesStore.getState().reset();
  // Clear toasts so each test starts clean.
  const ts = useToastsStore.getState();
  for (const t of ts.toasts) ts.dismiss(t.id);
}

describe("worktrees store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    freshState();
  });

  it("create appends a new worktree and returns it", async () => {
    const newWt = wt({ id: "wt-1", branch: "agent/one" });
    ipcMocked.createWorktree.mockResolvedValueOnce(newWt);
    const result = await useWorktreesStore.getState().create("ws-1", "one");
    expect(result).toEqual(newWt);
    expect(useWorktreesStore.getState().worktrees).toEqual([newWt]);
  });

  it("create failure fires a toast instead of wedging store.error", async () => {
    ipcMocked.createWorktree.mockRejectedValueOnce({
      kind: "AlreadyOpen",
      message: "worktree dir exists",
    });
    const result = await useWorktreesStore.getState().create("ws-1", "dup");
    expect(result).toBe(null);
    expect(useWorktreesStore.getState().creating).toBe(false);
    // The error surfaced as a toast, not a stuck inline field.
    const toasts = useToastsStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("error");
    expect(toasts[0].body).toContain("worktree dir exists");
  });

  it("remove drops the worktree from the list", async () => {
    const a = wt({ id: "a", branch: "agent/a" });
    const b = wt({ id: "b", branch: "agent/b" });
    useWorktreesStore.setState({ worktrees: [a, b] });
    ipcMocked.removeWorktree.mockResolvedValueOnce(undefined);
    await useWorktreesStore.getState().remove("a", true);
    expect(useWorktreesStore.getState().worktrees).toEqual([b]);
  });

  it("remove failure leaves the list intact and toasts", async () => {
    const a = wt({ id: "a" });
    useWorktreesStore.setState({ worktrees: [a] });
    ipcMocked.removeWorktree.mockRejectedValueOnce({ message: "nope" });
    await useWorktreesStore.getState().remove("a");
    expect(useWorktreesStore.getState().worktrees).toEqual([a]);
    expect(useToastsStore.getState().toasts.length).toBe(1);
  });

  it("refresh replaces the list from the backend", async () => {
    const list = [wt({ id: "x" }), wt({ id: "y" })];
    ipcMocked.listWorktrees.mockResolvedValueOnce(list);
    await useWorktreesStore.getState().refresh("ws-1");
    expect(useWorktreesStore.getState().worktrees).toEqual(list);
    expect(useWorktreesStore.getState().loading).toBe(false);
  });

  it("creating flag flips around the IPC call", async () => {
    let resolve!: (w: Worktree) => void;
    ipcMocked.createWorktree.mockImplementationOnce(
      () => new Promise((r) => (resolve = r)),
    );
    const p = useWorktreesStore.getState().create("ws-1", "pending");
    expect(useWorktreesStore.getState().creating).toBe(true);
    resolve(wt({ id: "p" }));
    await p;
    expect(useWorktreesStore.getState().creating).toBe(false);
  });
});
