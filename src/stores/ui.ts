import { create } from "zustand";
import type { WorktreeId } from "@/ipc/types";

type UiState = {
  selectedWorktreeId: WorktreeId | null;
  selectWorktree: (id: WorktreeId | null) => void;
  reset: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  selectedWorktreeId: null,
  selectWorktree(id) {
    set({ selectedWorktreeId: id });
  },
  reset() {
    set({ selectedWorktreeId: null });
  },
}));
