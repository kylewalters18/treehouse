import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ipc from "@/ipc/client";
import type { Workspace } from "@/ipc/types";
import { useWorkspaceStore, workspaceForWorktree } from "./workspace";

vi.mock("@/ipc/client");
const ipcMocked = vi.mocked(ipc);

function freshState() {
  useWorkspaceStore.setState({ workspaces: [], loading: false, error: null });
}

const WS_A: Workspace = {
  id: "ws-a",
  root: "/tmp/repo-a",
  defaultBranch: "main",
};
const WS_B: Workspace = {
  id: "ws-b",
  root: "/tmp/repo-b",
  defaultBranch: "trunk",
};

describe("workspace store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    freshState();
  });

  it("openWorkspace hydrates from listWorkspaces on success", async () => {
    // The store always re-hydrates after open instead of optimistically
    // pushing — keeps it convergent with Rust state, which de-dupes by
    // root and is the source of truth.
    ipcMocked.openWorkspace.mockResolvedValueOnce(WS_A);
    ipcMocked.listWorkspaces.mockResolvedValueOnce([WS_A]);
    await useWorkspaceStore.getState().openWorkspace("/tmp/repo-a");
    const s = useWorkspaceStore.getState();
    expect(s.workspaces).toEqual([WS_A]);
    expect(s.loading).toBe(false);
    expect(s.error).toBe(null);
  });

  it("openWorkspace surfaces a readable error message on failure", async () => {
    ipcMocked.openWorkspace.mockRejectedValueOnce({
      kind: "NotAGitRepo",
      message: "not a repo",
    });
    await useWorkspaceStore.getState().openWorkspace("/not/a/repo");
    const s = useWorkspaceStore.getState();
    expect(s.workspaces).toEqual([]);
    expect(s.error).toBe("not a repo");
    expect(s.error).not.toBe("[object Object]");
    expect(s.loading).toBe(false);
  });

  it("openWorkspace on a second repo appends rather than replacing", async () => {
    // The multi-repo invariant: opening a new workspace must not drop
    // the previously open one.
    useWorkspaceStore.setState({ workspaces: [WS_A], loading: false, error: null });
    ipcMocked.openWorkspace.mockResolvedValueOnce(WS_B);
    ipcMocked.listWorkspaces.mockResolvedValueOnce([WS_A, WS_B]);
    await useWorkspaceStore.getState().openWorkspace("/tmp/repo-b");
    expect(useWorkspaceStore.getState().workspaces).toEqual([WS_A, WS_B]);
  });

  it("closeWorkspace removes the targeted repo and leaves the rest", async () => {
    useWorkspaceStore.setState({
      workspaces: [WS_A, WS_B],
      loading: false,
      error: null,
    });
    ipcMocked.closeWorkspace.mockResolvedValueOnce(undefined);
    ipcMocked.listWorkspaces.mockResolvedValueOnce([WS_B]);
    await useWorkspaceStore.getState().closeWorkspace(WS_A.id);
    expect(ipcMocked.closeWorkspace).toHaveBeenCalledWith(WS_A.id);
    expect(useWorkspaceStore.getState().workspaces).toEqual([WS_B]);
  });

  it("closeWorkspace still re-hydrates even if the backend rejects", async () => {
    useWorkspaceStore.setState({
      workspaces: [WS_A, WS_B],
      loading: false,
      error: null,
    });
    ipcMocked.closeWorkspace.mockRejectedValueOnce(new Error("boom"));
    ipcMocked.listWorkspaces.mockResolvedValueOnce([WS_B]);
    await useWorkspaceStore.getState().closeWorkspace(WS_A.id);
    expect(useWorkspaceStore.getState().workspaces).toEqual([WS_B]);
  });

  it("hydrate replaces the workspaces list with Rust's source of truth", async () => {
    useWorkspaceStore.setState({ workspaces: [WS_A], loading: false, error: null });
    ipcMocked.listWorkspaces.mockResolvedValueOnce([WS_A, WS_B]);
    await useWorkspaceStore.getState().hydrate();
    expect(useWorkspaceStore.getState().workspaces).toEqual([WS_A, WS_B]);
  });

  it("loading flag flips around the open IPC", async () => {
    let resolveOpen!: (w: Workspace) => void;
    ipcMocked.openWorkspace.mockImplementationOnce(
      () => new Promise<Workspace>((r) => (resolveOpen = r)),
    );
    ipcMocked.listWorkspaces.mockResolvedValueOnce([WS_A]);
    const p = useWorkspaceStore.getState().openWorkspace("/tmp/repo-a");
    expect(useWorkspaceStore.getState().loading).toBe(true);
    resolveOpen(WS_A);
    await p;
    expect(useWorkspaceStore.getState().loading).toBe(false);
  });

  it("workspaceForWorktree resolves a workspace by id", () => {
    useWorkspaceStore.setState({
      workspaces: [WS_A, WS_B],
      loading: false,
      error: null,
    });
    expect(workspaceForWorktree(WS_B.id)).toEqual(WS_B);
    expect(workspaceForWorktree(undefined)).toBe(null);
    expect(workspaceForWorktree("missing" as unknown as Workspace["id"])).toBe(
      null,
    );
  });
});
