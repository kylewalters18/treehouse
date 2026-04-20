import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { Workspace } from "@/ipc/types";

type WorkspaceState = {
  workspace: Workspace | null;
  loading: boolean;
  error: string | null;
  openWorkspace: (path: string) => Promise<void>;
  closeWorkspace: () => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspace: null,
  loading: false,
  error: null,
  async openWorkspace(path: string) {
    set({ loading: true, error: null });
    try {
      const ws = await ipc.openWorkspace(path);
      set({ workspace: ws, loading: false });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ error: msg, loading: false });
    }
  },
  closeWorkspace() {
    set({ workspace: null, error: null });
  },
}));
