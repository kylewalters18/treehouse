import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { Worktree, WorkspaceId, WorktreeId } from "@/ipc/types";
import { asMessage } from "@/lib/errors";
import { toastError, toastInfo } from "@/stores/toasts";

type WorktreesState = {
  worktrees: Worktree[];
  loading: boolean;
  creating: boolean;
  refresh: (workspaceId: WorkspaceId) => Promise<void>;
  create: (
    workspaceId: WorkspaceId,
    name: string,
    opts?: { initSubmodules?: boolean },
  ) => Promise<Worktree | null>;
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
  async create(workspaceId, name, opts = {}) {
    set({ creating: true });
    try {
      const result = await ipc.createWorktree(workspaceId, name, opts);
      set({
        worktrees: [...get().worktrees, result.worktree],
        creating: false,
      });
      // Backend returns a non-fatal warning (e.g. submodule init failed) the
      // user should know about — surface as an info toast since the worktree
      // itself is alive and usable.
      if (result.warning) {
        toastInfo(`${result.worktree.branch}: ${result.warning}`);
      }
      return result.worktree;
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
