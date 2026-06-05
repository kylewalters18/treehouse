import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { Worktree, WorkspaceId, WorktreeId } from "@/ipc/types";
import { asMessage } from "@/lib/errors";
import { toastError, toastInfo } from "@/stores/toasts";
import { useEditorViewStateStore } from "@/stores/editor-view-state";
import { clearAgentLeafStatesForWorktree } from "@/panels/agent-leaf-state";

type WorktreesState = {
  /// Flat list across every open workspace. Each Worktree carries its
  /// own `workspaceId` so consumers filter at render time. Multi-repo:
  /// `refresh(workspaceId)` merges (replaces only that workspace's
  /// entries); never `replace-all` or other repos' worktrees vanish.
  worktrees: Worktree[];
  loading: boolean;
  creating: boolean;
  refresh: (workspaceId: WorkspaceId) => Promise<void>;
  refreshAll: (workspaceIds: WorkspaceId[]) => Promise<void>;
  /// Drop every entry for a given workspace. Called when a repo is
  /// closed so the sidebar doesn't briefly show its (now-orphaned)
  /// worktrees before the next refresh.
  dropForWorkspace: (workspaceId: WorkspaceId) => void;
  create: (
    workspaceId: WorkspaceId,
    name: string,
    opts?: { initSubmodules?: boolean; base?: string | null },
  ) => Promise<Worktree | null>;
  /// Create a worktree+branch from a forge issue (`<number>-<slug>`). Same
  /// append semantics as `create`; the branch name carries the issue link.
  /// `base` is the source branch to fork from (null → origin/<default>).
  createFromIssue: (
    workspaceId: WorkspaceId,
    number: number,
    base?: string | null,
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
      // Merge: drop only this workspace's prior entries, then append
      // the fresh ones. Other workspaces' worktrees stay put.
      set((s) => ({
        worktrees: [
          ...s.worktrees.filter((w) => w.workspaceId !== workspaceId),
          ...list,
        ],
        loading: false,
      }));
    } catch (e: unknown) {
      toastError("Failed to list worktrees", asMessage(e));
      set({ loading: false });
    }
  },
  async refreshAll(workspaceIds) {
    if (workspaceIds.length === 0) {
      set({ worktrees: [], loading: false });
      return;
    }
    await Promise.all(workspaceIds.map((id) => get().refresh(id)));
  },
  dropForWorkspace(workspaceId) {
    set((s) => ({
      worktrees: s.worktrees.filter((w) => w.workspaceId !== workspaceId),
    }));
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
  async createFromIssue(workspaceId, number, base = null) {
    set({ creating: true });
    try {
      const result = await ipc.forgeCreateWorktreeFromIssue(workspaceId, number, base);
      set({
        worktrees: [...get().worktrees, result.worktree],
        creating: false,
      });
      if (result.warning) {
        toastInfo(`${result.worktree.branch}: ${result.warning}`);
      }
      return result.worktree;
    } catch (e: unknown) {
      toastError(`Couldn't create worktree for #${number}`, asMessage(e));
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
