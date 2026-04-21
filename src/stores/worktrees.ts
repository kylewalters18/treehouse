import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { Worktree, WorkspaceId, WorktreeId } from "@/ipc/types";
import { asMessage } from "@/lib/errors";
import { toastError } from "@/stores/toasts";

type WorktreesState = {
  worktrees: Worktree[];
  loading: boolean;
  creating: boolean;
  refresh: (workspaceId: WorkspaceId) => Promise<void>;
  create: (workspaceId: WorkspaceId, name: string) => Promise<Worktree | null>;
  remove: (worktreeId: WorktreeId, force?: boolean) => Promise<void>;
  reset: () => void;
};

export const useWorktreesStore = create<WorktreesState>((set, get) => ({
  worktrees: [],
  loading: false,
  creating: false,
  async refresh(workspaceId) {
    set({ loading: true });
    try {
      const list = await ipc.listWorktrees(workspaceId);
      set({ worktrees: list, loading: false });
    } catch (e: unknown) {
      toastError("Failed to list worktrees", asMessage(e));
      set({ loading: false });
    }
  },
  async create(workspaceId, name) {
    set({ creating: true });
    try {
      const wt = await ipc.createWorktree(workspaceId, name);
      set({
        worktrees: [...get().worktrees, wt],
        creating: false,
      });
      return wt;
    } catch (e: unknown) {
      toastError(`Couldn't create "${name}"`, asMessage(e));
      set({ creating: false });
      return null;
    }
  },
  async remove(worktreeId, force = false) {
    try {
      await ipc.removeWorktree(worktreeId, force);
      set({
        worktrees: get().worktrees.filter((w) => w.id !== worktreeId),
      });
    } catch (e: unknown) {
      toastError("Failed to remove worktree", asMessage(e));
    }
  },
  reset() {
    set({ worktrees: [], loading: false, creating: false });
  },
}));
