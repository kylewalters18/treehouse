import type { editor as MonacoEditor } from "monaco-editor";
import { create } from "zustand";
import type { WorktreeId } from "@/ipc/types";

/// Per-(worktree, file, kind) Monaco view state — scroll position,
/// cursor, selections, folded ranges, etc. — captured by
/// `editor.saveViewState()`. Restored on the next mount of the
/// editor for the same key so a worktree round-trip leaves the user
/// where they were.
///
/// `kind` discriminates the file editor from the diff editor's
/// modified side: same path, different content (full file vs
/// `[hidden]…hunk…[hidden]`), so a shared scroll offset would land
/// in the wrong spot.
///
/// In-memory only: lives for the app session. Worktree IDs are
/// ephemeral across restarts anyway, so a session-scoped key is the
/// right granularity for now. Disk persistence is left for later if
/// it turns out users miss it.

type Key = string;

export type ViewKind = "file" | "diff";

function keyFor(
  worktreeId: WorktreeId,
  path: string,
  kind: ViewKind,
): Key {
  return `${kind}:${worktreeId} ${path}`;
}

type State = {
  byKey: Record<Key, MonacoEditor.ICodeEditorViewState>;
  get: (
    worktreeId: WorktreeId,
    path: string,
    kind: ViewKind,
  ) => MonacoEditor.ICodeEditorViewState | null;
  save: (
    worktreeId: WorktreeId,
    path: string,
    kind: ViewKind,
    viewState: MonacoEditor.ICodeEditorViewState | null,
  ) => void;
  clearForWorktree: (worktreeId: WorktreeId) => void;
  reset: () => void;
};

export const useEditorViewStateStore = create<State>((set, get) => ({
  byKey: {},
  get(worktreeId, path, kind) {
    return get().byKey[keyFor(worktreeId, path, kind)] ?? null;
  },
  save(worktreeId, path, kind, viewState) {
    if (!viewState) return;
    set((s) => ({
      byKey: { ...s.byKey, [keyFor(worktreeId, path, kind)]: viewState },
    }));
  },
  clearForWorktree(worktreeId) {
    // Called when a worktree is removed so we don't accumulate dead
    // entries for paths that no longer exist on disk. Match `:<wt> `
    // anywhere after the kind prefix (`file:` / `diff:`).
    const needle = `:${worktreeId} `;
    set((s) => {
      const next: Record<Key, MonacoEditor.ICodeEditorViewState> = {};
      for (const [k, v] of Object.entries(s.byKey)) {
        if (!k.includes(needle)) next[k] = v;
      }
      return { byKey: next };
    });
  },
  reset() {
    set({ byKey: {} });
  },
}));
