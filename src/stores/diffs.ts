import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { DiffSet, WorktreeId } from "@/ipc/types";

type DiffView = "diff" | "file";

type DiffsState = {
  byWorktree: Record<WorktreeId, DiffSet>;
  loading: Record<WorktreeId, boolean>;
  error: Record<WorktreeId, string | null>;
  selectedFile: Record<WorktreeId, string | null>;
  view: Record<WorktreeId, DiffView>;
  fetch: (worktreeId: WorktreeId) => Promise<void>;
  set: (worktreeId: WorktreeId, diff: DiffSet) => void;
  selectFile: (worktreeId: WorktreeId, path: string | null) => void;
  setView: (worktreeId: WorktreeId, view: DiffView) => void;
  reset: () => void;
};

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return e instanceof Error ? e.message : String(e);
}

export const useDiffsStore = create<DiffsState>((set, get) => ({
  byWorktree: {},
  loading: {},
  error: {},
  selectedFile: {},
  view: {},
  async fetch(worktreeId) {
    set((s) => ({
      loading: { ...s.loading, [worktreeId]: true },
      error: { ...s.error, [worktreeId]: null },
    }));
    try {
      const d = await ipc.getDiff(worktreeId);
      set((s) => ({
        byWorktree: { ...s.byWorktree, [worktreeId]: d },
        loading: { ...s.loading, [worktreeId]: false },
      }));
    } catch (e: unknown) {
      set((s) => ({
        error: { ...s.error, [worktreeId]: asMessage(e) },
        loading: { ...s.loading, [worktreeId]: false },
      }));
    }
  },
  set(worktreeId, diff) {
    set((s) => {
      const prev = s.selectedFile[worktreeId];
      const keep = prev && diff.files.some((f) => f.path === prev);
      return {
        byWorktree: { ...s.byWorktree, [worktreeId]: diff },
        selectedFile: {
          ...s.selectedFile,
          [worktreeId]: keep ? prev : (diff.files[0]?.path ?? null),
        },
      };
    });
    void get; // silence unused warning if get isn't otherwise referenced
  },
  selectFile(worktreeId, path) {
    set((s) => ({
      selectedFile: { ...s.selectedFile, [worktreeId]: path },
    }));
  },
  setView(worktreeId, view) {
    set((s) => ({ view: { ...s.view, [worktreeId]: view } }));
  },
  reset() {
    set({ byWorktree: {}, loading: {}, error: {}, selectedFile: {}, view: {} });
  },
}));
