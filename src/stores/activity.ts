import { create } from "zustand";
import type { WorktreeActivity, WorktreeId } from "@/ipc/types";

/// Latest agent-activity snapshot per worktree, across every open repo.
/// The worktree sidebar owns the 1.5s poll and writes here; the status
/// bar reads the same snapshot instead of polling a second time.
type ActivityState = {
  byWorktree: Record<WorktreeId, WorktreeActivity>;
  setAll: (map: Record<WorktreeId, WorktreeActivity>) => void;
};

export const useActivityStore = create<ActivityState>((set) => ({
  byWorktree: {},
  setAll: (byWorktree) => set({ byWorktree }),
}));
