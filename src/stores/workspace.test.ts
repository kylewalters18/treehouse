import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ipc from "@/ipc/client";
import type { Workspace } from "@/ipc/types";
import { useWorkspaceStore } from "./workspace";

vi.mock("@/ipc/client");
const ipcMocked = vi.mocked(ipc);

function freshState() {
  useWorkspaceStore.setState({ workspace: null, loading: false, error: null });
}

const WS: Workspace = {
  id: "ws-1",
  root: "/tmp/repo",
  defaultBranch: "main",
};

describe("workspace store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    freshState();
  });

  it("openWorkspace stores the Workspace on success", async () => {
    ipcMocked.openWorkspace.mockResolvedValueOnce(WS);
    await useWorkspaceStore.getState().openWorkspace("/tmp/repo");
    const s = useWorkspaceStore.getState();
    expect(s.workspace).toEqual(WS);
    expect(s.loading).toBe(false);
    expect(s.error).toBe(null);
  });

  it("openWorkspace stores a readable error message on failure", async () => {
    ipcMocked.openWorkspace.mockRejectedValueOnce({
      kind: "NotAGitRepo",
      message: "not a repo",
    });
    await useWorkspaceStore.getState().openWorkspace("/not/a/repo");
    const s = useWorkspaceStore.getState();
    expect(s.workspace).toBe(null);
    expect(s.error).toBe("not a repo");
    // Regression: we used to serialize objects to "[object Object]".
    expect(s.error).not.toBe("[object Object]");
    expect(s.loading).toBe(false);
  });

  it("closeWorkspace calls the backend before clearing", async () => {
    useWorkspaceStore.setState({ workspace: WS, loading: false, error: null });
    ipcMocked.closeWorkspace.mockResolvedValueOnce(undefined);
    await useWorkspaceStore.getState().closeWorkspace();
    expect(ipcMocked.closeWorkspace).toHaveBeenCalledWith(WS.id);
    expect(useWorkspaceStore.getState().workspace).toBe(null);
  });

  it("closeWorkspace still clears the UI even if the backend rejects", async () => {
    useWorkspaceStore.setState({ workspace: WS, loading: false, error: null });
    ipcMocked.closeWorkspace.mockRejectedValueOnce(new Error("boom"));
    await useWorkspaceStore.getState().closeWorkspace();
    expect(useWorkspaceStore.getState().workspace).toBe(null);
  });

  it("loading flag flips around the IPC call", async () => {
    let resolve!: (w: typeof WS) => void;
    ipcMocked.openWorkspace.mockImplementationOnce(
      () => new Promise((r) => (resolve = r)),
    );
    const p = useWorkspaceStore.getState().openWorkspace("/tmp/repo");
    expect(useWorkspaceStore.getState().loading).toBe(true);
    resolve(WS);
    await p;
    expect(useWorkspaceStore.getState().loading).toBe(false);
  });
});
