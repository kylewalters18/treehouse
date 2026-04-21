import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { Workspace } from "@/ipc/types";
import { asMessage } from "@/lib/errors";

type WorkspaceState = {
  workspace: Workspace | null;
  loading: boolean;
  error: string | null;
  openWorkspace: (path: string) => Promise<void>;
  closeWorkspace: () => Promise<void>;
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspace: null,
  loading: false,
  error: null,
  async openWorkspace(path: string) {
    set({ loading: true, error: null });
    try {
      const ws = await ipc.openWorkspace(path);
      set({ workspace: ws, loading: false });
    } catch (e: unknown) {
      set({ error: asMessage(e), loading: false });
    }
  },
  async closeWorkspace() {
    const current = get().workspace;
    if (current) {
      try {
        await ipc.closeWorkspace(current.id);
      } catch (e) {
        // Tearing down is best-effort; even if Rust reports a problem, the
        // UI should still return to Home so the user isn't stuck.
        console.warn("close_workspace failed", e);
      }
    }
    set({ workspace: null, error: null });
  },
}));
