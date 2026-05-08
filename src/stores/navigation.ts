import { create } from "zustand";
import type { WorktreeId } from "@/ipc/types";
import { useDiffsStore } from "./diffs";

/// Per-worktree linear history of cursor positions, à la VS Code's
/// Go Back / Go Forward. Each entry is `(path, line, column)` and
/// captures a "place the user was looking at." Each worktree gets
/// its own stack so jumping between worktrees doesn't collide
/// (and the cursor-position view-state is also per-worktree).
///
/// Recording semantics — same shape as VS Code:
/// - File switch always pushes a new entry.
/// - Same file, big jump (≥ `SAME_FILE_LINE_THRESHOLD` lines from
///   the current entry's line) pushes a new entry.
/// - Same file, small move (typing, arrow-key navigation, line-by-
///   line scroll) updates the current entry in place — back from a
///   different file lands you where you actually were when you
///   left, not where you originally entered the file.
///
/// Back/forward replay an entry by setting `selectedFile` +
/// `pendingReveal` on the diffs store. The reveal hook in
/// EditorPane handles the rest: model swap (if cross-file) +
/// `editor.setPosition`. To prevent the resulting cursor moves
/// from re-pushing onto the stack we set a short `navigatingUntil`
/// window during which `record` is a no-op.
export type NavEntry = {
  path: string;
  line: number;
  column: number;
};

type NavStack = {
  entries: NavEntry[];
  /// Index of the entry the user is currently "at" in the stack —
  /// `back` decrements, `forward` increments. `-1` if empty.
  index: number;
};

type NavState = {
  byWorktree: Record<WorktreeId, NavStack>;
  /// Per-worktree epoch ms before which `record` calls are
  /// suppressed. Set during back/forward so the model-swap and
  /// pendingReveal-driven cursor moves don't pollute history.
  navigatingUntil: Record<WorktreeId, number>;

  record: (
    worktreeId: WorktreeId,
    path: string,
    line: number,
    column: number,
  ) => void;
  back: (worktreeId: WorktreeId) => void;
  forward: (worktreeId: WorktreeId) => void;
  /// Direct jump to a specific entry by stack index. Used by the
  /// history dropdown — same replay path as back/forward, just
  /// arbitrary index instead of ±1.
  jumpTo: (worktreeId: WorktreeId, index: number) => void;
  canGoBack: (worktreeId: WorktreeId) => boolean;
  canGoForward: (worktreeId: WorktreeId) => boolean;
  clear: (worktreeId: WorktreeId) => void;
};

/// "Big jump" threshold — same-file moves smaller than this update
/// the current entry rather than pushing. 10 lines roughly matches
/// VS Code's `cursorSurroundingLines`-derived heuristic and feels
/// right for "yeah, I was looking at that section."
const SAME_FILE_LINE_THRESHOLD = 10;
/// Cap to keep the stack from growing forever in long sessions.
/// Eviction is FIFO; the oldest entry is dropped when we'd exceed.
const MAX_ENTRIES = 100;
/// How long to suppress `record` calls after a back/forward fires.
/// Covers EditorWithComments remount + view-state restore +
/// pendingReveal — all of which fire `onDidChangeCursorPosition`
/// before the cursor settles at the target.
const NAV_SETTLE_MS = 500;

export const useNavigationStore = create<NavState>((set, get) => ({
  byWorktree: {},
  navigatingUntil: {},

  record(worktreeId, path, line, column) {
    if (Date.now() < (get().navigatingUntil[worktreeId] ?? 0)) return;
    const stack = get().byWorktree[worktreeId];
    if (!stack || stack.index < 0 || stack.entries.length === 0) {
      set((s) => ({
        byWorktree: {
          ...s.byWorktree,
          [worktreeId]: { entries: [{ path, line, column }], index: 0 },
        },
      }));
      return;
    }
    const cur = stack.entries[stack.index];
    const sameFile = cur.path === path;
    const smallMove =
      sameFile && Math.abs(line - cur.line) < SAME_FILE_LINE_THRESHOLD;
    if (smallMove) {
      // Update in place. Don't bother set()-ing if the position is
      // unchanged — saves a re-render in the common arrow-key case.
      if (cur.line === line && cur.column === column) return;
      const next = stack.entries.slice();
      next[stack.index] = { path, line, column };
      set((s) => ({
        byWorktree: {
          ...s.byWorktree,
          [worktreeId]: { entries: next, index: stack.index },
        },
      }));
      return;
    }
    // Push: truncate any forward history then append.
    let entries = stack.entries.slice(0, stack.index + 1);
    entries.push({ path, line, column });
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(entries.length - MAX_ENTRIES);
    }
    set((s) => ({
      byWorktree: {
        ...s.byWorktree,
        [worktreeId]: { entries, index: entries.length - 1 },
      },
    }));
  },

  back(worktreeId) {
    const stack = get().byWorktree[worktreeId];
    if (!stack || stack.index <= 0) return;
    const target = stack.entries[stack.index - 1];
    set((s) => ({
      byWorktree: {
        ...s.byWorktree,
        [worktreeId]: { ...stack, index: stack.index - 1 },
      },
      navigatingUntil: {
        ...s.navigatingUntil,
        [worktreeId]: Date.now() + NAV_SETTLE_MS,
      },
    }));
    applyEntry(worktreeId, target);
  },

  forward(worktreeId) {
    const stack = get().byWorktree[worktreeId];
    if (!stack || stack.index >= stack.entries.length - 1) return;
    const target = stack.entries[stack.index + 1];
    set((s) => ({
      byWorktree: {
        ...s.byWorktree,
        [worktreeId]: { ...stack, index: stack.index + 1 },
      },
      navigatingUntil: {
        ...s.navigatingUntil,
        [worktreeId]: Date.now() + NAV_SETTLE_MS,
      },
    }));
    applyEntry(worktreeId, target);
  },

  jumpTo(worktreeId, index) {
    const stack = get().byWorktree[worktreeId];
    if (!stack || index < 0 || index >= stack.entries.length) return;
    if (index === stack.index) return;
    const target = stack.entries[index];
    set((s) => ({
      byWorktree: {
        ...s.byWorktree,
        [worktreeId]: { ...stack, index },
      },
      navigatingUntil: {
        ...s.navigatingUntil,
        [worktreeId]: Date.now() + NAV_SETTLE_MS,
      },
    }));
    applyEntry(worktreeId, target);
  },

  canGoBack(worktreeId) {
    const stack = get().byWorktree[worktreeId];
    return !!stack && stack.index > 0;
  },

  canGoForward(worktreeId) {
    const stack = get().byWorktree[worktreeId];
    return !!stack && stack.index < stack.entries.length - 1;
  },

  clear(worktreeId) {
    set((s) => {
      const byWorktree = { ...s.byWorktree };
      const navigatingUntil = { ...s.navigatingUntil };
      delete byWorktree[worktreeId];
      delete navigatingUntil[worktreeId];
      return { byWorktree, navigatingUntil };
    });
  },
}));

/// Replay an entry by routing through the existing diffs-store
/// pipeline: switch the active file, flip to the file view (in
/// case the user was on Diff/Preview), and queue a pendingReveal
/// so the EditorPane lands the cursor on the recorded line/column
/// after the model swap.
function applyEntry(worktreeId: WorktreeId, entry: NavEntry): void {
  const ds = useDiffsStore.getState();
  ds.setView(worktreeId, "file");
  ds.selectFile(worktreeId, entry.path);
  ds.setPendingReveal(worktreeId, {
    path: entry.path,
    line: entry.line,
    column: entry.column,
  });
}
