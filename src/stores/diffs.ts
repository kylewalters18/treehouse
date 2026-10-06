import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { BranchCommits, DiffSet, WorktreeId } from "@/ipc/types";

type DiffView = "diff" | "file" | "preview";

/// Which Changes-list group a selection came from. `branch` is the
/// merge-base-anchored "PR-style" diff (what merge-back ships);
/// `uncommitted` is HEAD..workdir (what the agent touched since the
/// last commit). `commit` is the History tab's selected commit
/// (parent..commit). A path can appear in several with different hunks.
export type ChangeGroup = "branch" | "uncommitted" | "commit";

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
  /// History tab: commits on the branch since its merge-base, newest first.
  commitsByWorktree: Record<WorktreeId, BranchCommits>;
  /// Full sha of the commit the History tab has open.
  selectedCommit: Record<WorktreeId, string | null>;
  /// Per-commit diffs keyed by full sha. Commits are immutable, so
  /// entries never go stale.
  commitDiffs: Record<string, DiffSet>;
  commitDiffError: Record<WorktreeId, string | null>;
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
  fetchCommits: (worktreeId: WorktreeId) => Promise<void>;
  /// Open a commit in the History tab, fetching its diff if uncached.
  /// Keeps the selected file when the commit touched it, else picks the
  /// commit's first file, and shows the Diff view.
  selectCommit: (worktreeId: WorktreeId, sha: string | null) => Promise<void>;
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
/// Same guard for the commit list (refetched on fs events and ref moves).
const commitsSeq: Record<WorktreeId, number> = {};

export const useDiffsStore = create<DiffsState>((set, get) => ({
  byWorktree: {},
  uncommittedByWorktree: {},
  loading: {},
  error: {},
  selectedFile: {},
  selectedGroup: {},
  view: {},
  commitsByWorktree: {},
  selectedCommit: {},
  commitDiffs: {},
  commitDiffError: {},
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
  async fetchCommits(worktreeId) {
    const seq = (commitsSeq[worktreeId] ?? 0) + 1;
    commitsSeq[worktreeId] = seq;
    const list = await ipc.listBranchCommits(worktreeId);
    if (commitsSeq[worktreeId] !== seq) return;
    set((s) => {
      // A rebase / amend can drop the open commit; fall back to the
      // branch diff rather than showing a commit that's left the branch.
      const sel = s.selectedCommit[worktreeId];
      const gone = sel != null && !list.commits.some((c) => c.sha === sel);
      return {
        commitsByWorktree: { ...s.commitsByWorktree, [worktreeId]: list },
        ...(gone && {
          selectedCommit: { ...s.selectedCommit, [worktreeId]: null },
          ...(s.selectedGroup[worktreeId] === "commit" && {
            selectedGroup: { ...s.selectedGroup, [worktreeId]: "branch" },
          }),
        }),
      };
    });
  },
  async selectCommit(worktreeId, sha) {
    set((s) => ({
      selectedCommit: { ...s.selectedCommit, [worktreeId]: sha },
      commitDiffError: { ...s.commitDiffError, [worktreeId]: null },
    }));
    if (!sha) return;
    let d = get().commitDiffs[sha];
    if (!d) {
      try {
        d = await ipc.getCommitDiff(worktreeId, sha);
      } catch (e: unknown) {
        if (get().selectedCommit[worktreeId] !== sha) return;
        set((s) => ({
          commitDiffError: { ...s.commitDiffError, [worktreeId]: asMessage(e) },
        }));
        return;
      }
      set((s) => ({ commitDiffs: { ...s.commitDiffs, [sha]: d! } }));
    }
    // A later click won the race; leave its selection alone.
    if (get().selectedCommit[worktreeId] !== sha) return;
    const prev = get().selectedFile[worktreeId];
    const path = prev && d.files.some((f) => f.path === prev)
      ? prev
      : (d.files[0]?.path ?? null);
    set((s) => ({
      selectedFile: { ...s.selectedFile, [worktreeId]: path },
      selectedGroup: { ...s.selectedGroup, [worktreeId]: "commit" },
      ...(path && { view: { ...s.view, [worktreeId]: "diff" } }),
    }));
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
      commitsByWorktree: {},
      selectedCommit: {},
      commitDiffs: {},
      commitDiffError: {},
      pendingReveal: {},
    });
  },
}));
