/// Open workspaces in the current session (multi-repo). The
/// authoritative state lives in Rust `AppState.workspaces`; this store
/// mirrors it for the renderer. Mutations always go through the IPC
/// layer (which appends/removes from the persisted open-set), then we
/// re-hydrate from `list_workspaces` rather than mutating the array
/// optimistically — keeps the renderer convergent with whatever the
/// Rust side actually has.
import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { Workspace, WorkspaceId } from "@/ipc/types";
import { asMessage } from "@/lib/errors";

type WorkspaceState = {
  /// Currently-open workspaces, ordered by the underlying Rust state's
  /// DashMap iteration. Stable enough for sidebar grouping; not a
  /// guaranteed insertion order across full app restarts.
  workspaces: Workspace[];
  /// Set true while an `open` or `close` IPC is in flight so the UI can
  /// disable buttons. The store hydration on app mount also flips this.
  loading: boolean;
  error: string | null;
  /// Open a repo. Idempotent — Rust de-dupes by root path, and the
  /// store always re-hydrates from `list_workspaces` so duplicates can't
  /// sneak in.
  openWorkspace: (path: string) => Promise<void>;
  /// Close a specific repo. With no id given, closes the active workspace
  /// (the one owning `useUiStore.selectedWorktreeId`, resolved by the
  /// caller). Multiple repos can stay open after a close.
  closeWorkspace: (id: WorkspaceId) => Promise<void>;
  /// Hydrate from the Rust source of truth. Called on app boot and
  /// again whenever `app://workspaces-restored` fires (after the boot
  /// restore completes).
  hydrate: () => Promise<void>;
  /// Set (or clear, with `null`) the base ref the Changes diff compares
  /// against for a workspace. Persisted Rust-side and applied to the live
  /// state; we patch the returned workspace into the array so the picker
  /// reflects the new value without a full re-hydrate. The Rust side also
  /// recomputes every worktree diff, which arrives via `diff_updated`.
  setBaseRef: (id: WorkspaceId, baseRef: string | null) => Promise<void>;
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspaces: [],
  loading: false,
  error: null,
  async openWorkspace(path: string) {
    set({ loading: true, error: null });
    try {
      await ipc.openWorkspace(path);
      const workspaces = await ipc.listWorkspaces();
      set({ workspaces, loading: false });
    } catch (e: unknown) {
      set({ error: asMessage(e), loading: false });
    }
  },
  async closeWorkspace(id: WorkspaceId) {
    try {
      await ipc.closeWorkspace(id);
    } catch (e) {
      // Tearing down is best-effort; surface in console + still re-
      // hydrate so the renderer reflects whatever Rust actually has.
      console.warn("close_workspace failed", e);
    }
    try {
      const workspaces = await ipc.listWorkspaces();
      set({ workspaces, error: null });
    } catch (e) {
      console.warn("listWorkspaces after close failed", e);
    }
  },
  async hydrate() {
    try {
      const workspaces = await ipc.listWorkspaces();
      set({ workspaces, loading: false });
    } catch (e: unknown) {
      set({ error: asMessage(e), loading: false });
    }
  },
  async setBaseRef(id: WorkspaceId, baseRef: string | null) {
    const updated = await ipc.setWorkspaceBaseRef(id, baseRef);
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? updated : w)),
    }));
  },
}));

/// Look up the workspace that owns a given worktree. Worktrees carry
/// `workspaceId`, so this is a pure indirection — handy for components
/// that have a worktree in hand and need its repo's root or default
/// branch.
export function workspaceForWorktree(
  worktreeWorkspaceId: WorkspaceId | undefined | null,
): Workspace | null {
  if (!worktreeWorkspaceId) return null;
  return (
    useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === worktreeWorkspaceId) ?? null
  );
}
