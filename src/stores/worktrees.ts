import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { Worktree, WorkspaceId, WorktreeId } from "@/ipc/types";
import { asMessage } from "@/lib/errors";
import { toastError, toastInfo } from "@/stores/toasts";
import { useEditorViewStateStore } from "@/stores/editor-view-state";
import { clearAgentLeafStatesForWorktree } from "@/panels/agent-leaf-state";

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
  remove: (
    worktreeId: WorktreeId,
    force?: boolean,
    skipHook?: boolean,
  ) => Promise<void>;
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
  async remove(worktreeId, force = false, skipHook = false) {
    try {
      const summary = await ipc.removeWorktree(worktreeId, force, skipHook);
      set({
        worktrees: get().worktrees.filter((w) => w.id !== worktreeId),
      });
      // Drop saved editor view states for this worktree's files so
      // the in-memory map doesn't accumulate entries for paths that
      // no longer exist.
      useEditorViewStateStore.getState().clearForWorktree(worktreeId);
      // Same for the agent xterm pool — kill any pooled sessions and
      // dispose their xterms so the removed worktree doesn't leak.
      clearAgentLeafStatesForWorktree(worktreeId);
      // Surface on_destroy hook outcomes only when something failed —
      // a clean run is silent. Worktree is already gone either way.
      if (summary.failed.length > 0) {
        const first = summary.failed[0];
        const more =
          summary.failed.length > 1
            ? ` (+${summary.failed.length - 1} more)`
            : "";
        toastError(
          `Cleanup hook: ${summary.failed.length}/${summary.ran} step${summary.ran === 1 ? "" : "s"} failed`,
          `${first.name}: ${first.reason}${more}`,
        );
      }
    } catch (e: unknown) {
      toastError("Failed to remove worktree", asMessage(e));
    }
  },
  reset() {
    set({ worktrees: [], loading: false, creating: false });
  },
}));
