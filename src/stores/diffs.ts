import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { DiffSet, WorktreeId } from "@/ipc/types";

type DiffView = "diff" | "file" | "preview";

/// Which Changes-list group a selection came from. `branch` is the
/// merge-base-anchored "PR-style" diff (what merge-back ships);
/// `uncommitted` is HEAD..workdir (what the agent touched since the
/// last commit). A path can appear in both with different hunks.
export type ChangeGroup = "branch" | "uncommitted";

/// `(line, column)` to reveal once a freshly-selected file finishes
/// loading in the editor. 1-indexed to match Monaco. Populated by the
/// cross-file LSP goto click handler and cleared by EditorPane after
/// the reveal runs.
export type PendingReveal = { path: string; line: number; column: number };

type DiffsState = {
  /// Branch diff (merge-base..workdir). The primary review surface.
  byWorktree: Record<WorktreeId, DiffSet>;
  /// Uncommitted diff (HEAD..workdir), shown as its own group above
  /// the branch diff.
  uncommittedByWorktree: Record<WorktreeId, DiffSet>;
  loading: Record<WorktreeId, boolean>;
  error: Record<WorktreeId, string | null>;
  selectedFile: Record<WorktreeId, string | null>;
  /// Which group's diff the Diff tab renders for the selected file.
  /// Falls back to the other group when the file isn't in this one.
  selectedGroup: Record<WorktreeId, ChangeGroup>;
  view: Record<WorktreeId, DiffView>;
  pendingReveal: Record<WorktreeId, PendingReveal | null>;
  /// Fetch both groups.
  fetch: (worktreeId: WorktreeId) => Promise<void>;
  fetchUncommitted: (worktreeId: WorktreeId) => Promise<void>;
  /// Accept a pushed branch diff (the `diff_updated` payload).
  set: (worktreeId: WorktreeId, diff: DiffSet) => void;
  /// `group` omitted keeps the current group — callers outside the
  /// Changes list (tree, finder, goto) don't care which diff shows.
  selectFile: (
    worktreeId: WorktreeId,
    path: string | null,
    group?: ChangeGroup,
  ) => void;
  setView: (worktreeId: WorktreeId, view: DiffView) => void;
  setPendingReveal: (
    worktreeId: WorktreeId,
    reveal: PendingReveal | null,
  ) => void;
  reset: () => void;
};

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return e instanceof Error ? e.message : String(e);
}

/// Per-worktree request counter for the uncommitted diff, which is
/// refetched on every fs event — drop responses that arrive after a
/// newer request was issued.
const uncommittedSeq: Record<WorktreeId, number> = {};

export const useDiffsStore = create<DiffsState>((set, get) => ({
  byWorktree: {},
  uncommittedByWorktree: {},
  loading: {},
  error: {},
  selectedFile: {},
  selectedGroup: {},
  view: {},
  pendingReveal: {},
  async fetch(worktreeId) {
    set((s) => ({
      loading: { ...s.loading, [worktreeId]: true },
      error: { ...s.error, [worktreeId]: null },
    }));
    try {
      const [d] = await Promise.all([
        ipc.getDiff(worktreeId, "branch"),
        get().fetchUncommitted(worktreeId),
      ]);
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
  async fetchUncommitted(worktreeId) {
    const seq = (uncommittedSeq[worktreeId] ?? 0) + 1;
    uncommittedSeq[worktreeId] = seq;
    const d = await ipc.getDiff(worktreeId, "uncommitted");
    if (uncommittedSeq[worktreeId] !== seq) return;
    set((s) => ({
      uncommittedByWorktree: { ...s.uncommittedByWorktree, [worktreeId]: d },
    }));
  },
  set(worktreeId, diff) {
    set((s) => {
      const prev = s.selectedFile[worktreeId];
      const uncommitted = s.uncommittedByWorktree[worktreeId];
      const keep =
        prev &&
        (diff.files.some((f) => f.path === prev) ||
          (uncommitted?.files.some((f) => f.path === prev) ?? false));
      return {
        byWorktree: { ...s.byWorktree, [worktreeId]: diff },
        selectedFile: {
          ...s.selectedFile,
          [worktreeId]: keep ? prev : (diff.files[0]?.path ?? null),
        },
      };
    });
  },
  selectFile(worktreeId, path, group) {
    set((s) => ({
      selectedFile: { ...s.selectedFile, [worktreeId]: path },
      ...(group && {
        selectedGroup: { ...s.selectedGroup, [worktreeId]: group },
      }),
    }));
  },
  setView(worktreeId, view) {
    set((s) => ({ view: { ...s.view, [worktreeId]: view } }));
  },
  setPendingReveal(worktreeId, reveal) {
    set((s) => ({
      pendingReveal: { ...s.pendingReveal, [worktreeId]: reveal },
    }));
  },
  reset() {
    set({
      byWorktree: {},
      uncommittedByWorktree: {},
      loading: {},
      error: {},
      selectedFile: {},
      selectedGroup: {},
      view: {},
      pendingReveal: {},
    });
  },
}));
