import { create } from "zustand";
import type { WorktreeId } from "@/ipc/types";

type UiState = {
  selectedWorktreeId: WorktreeId | null;
  focusMode: boolean;
  worktreeSidebarCollapsed: boolean;
  selectWorktree: (id: WorktreeId | null) => void;
  toggleFocusMode: () => void;
  setFocusMode: (on: boolean) => void;
  toggleWorktreeSidebar: () => void;
  setWorktreeSidebarCollapsed: (on: boolean) => void;
  reset: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  selectedWorktreeId: null,
  focusMode: false,
  worktreeSidebarCollapsed: false,
  selectWorktree(id) {
    set({ selectedWorktreeId: id });
  },
  toggleFocusMode() {
    set((s) => ({ focusMode: !s.focusMode }));
  },
  setFocusMode(on) {
    set({ focusMode: on });
  },
  toggleWorktreeSidebar() {
    set((s) => ({ worktreeSidebarCollapsed: !s.worktreeSidebarCollapsed }));
  },
  setWorktreeSidebarCollapsed(on) {
    set({ worktreeSidebarCollapsed: on });
  },
  reset() {
    set({
      selectedWorktreeId: null,
      focusMode: false,
      worktreeSidebarCollapsed: false,
    });
  },
}));
