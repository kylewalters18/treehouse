/// Per-(worktree, path) flag set by EditorPane when Monaco's model
/// diverges from the last-known disk content. Consumers (the file path
/// label in DiffPane, the close-confirmation flow, future autosave
/// timers) subscribe so the dirty dot updates reactively.
import { create } from "zustand";
import type { WorktreeId } from "@/ipc/types";

type State = {
  dirty: Record<string, boolean>;
  set: (worktreeId: WorktreeId, path: string, dirty: boolean) => void;
};

const keyOf = (worktreeId: WorktreeId, path: string) =>
  `${worktreeId}::${path}`;

export const useEditorDirtyStore = create<State>((set) => ({
  dirty: {},
  set(worktreeId, path, dirty) {
    set((s) => {
      const key = keyOf(worktreeId, path);
      // Avoid no-op rerenders.
      if ((s.dirty[key] ?? false) === dirty) return s;
      const next = { ...s.dirty };
      if (dirty) next[key] = true;
      else delete next[key];
      return { dirty: next };
    });
  },
}));

export function isEditorDirty(
  worktreeId: WorktreeId,
  path: string,
): boolean {
  return useEditorDirtyStore.getState().dirty[keyOf(worktreeId, path)] ?? false;
}

export function useIsEditorDirty(
  worktreeId: WorktreeId | null,
  path: string | null,
): boolean {
  return useEditorDirtyStore((s) =>
    worktreeId && path ? s.dirty[keyOf(worktreeId, path)] ?? false : false,
  );
}
