import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { Worktree, WorkspaceId, WorktreeId } from "@/ipc/types";

type WorktreesState = {
  worktrees: Worktree[];
  loading: boolean;
  creating: boolean;
  error: string | null;
  refresh: (workspaceId: WorkspaceId) => Promise<void>;
  create: (workspaceId: WorkspaceId, name: string) => Promise<Worktree | null>;
  remove: (
    worktreeId: WorktreeId,
    force?: boolean,
  ) => Promise<void>;
  reset: () => void;
};

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return e instanceof Error ? e.message : String(e);
}

export const useWorktreesStore = create<WorktreesState>((set, get) => ({
  worktrees: [],
  loading: false,
  creating: false,
  error: null,
  async refresh(workspaceId) {
    set({ loading: true, error: null });
    try {
      const list = await ipc.listWorktrees(workspaceId);
      set({ worktrees: list, loading: false });
    } catch (e: unknown) {
      set({ error: asMessage(e), loading: false });
    }
  },
  async create(workspaceId, name) {
    set({ creating: true, error: null });
    try {
      const wt = await ipc.createWorktree(workspaceId, name);
      set({
        worktrees: [...get().worktrees, wt],
        creating: false,
      });
      return wt;
    } catch (e: unknown) {
      set({ error: asMessage(e), creating: false });
      return null;
    }
  },
  async remove(worktreeId, force = false) {
    set({ error: null });
    try {
      await ipc.removeWorktree(worktreeId, force);
      set({
        worktrees: get().worktrees.filter((w) => w.id !== worktreeId),
      });
    } catch (e: unknown) {
      set({ error: asMessage(e) });
    }
  },
  reset() {
    set({ worktrees: [], loading: false, creating: false, error: null });
  },
}));
