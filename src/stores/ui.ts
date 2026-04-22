import { create } from "zustand";
import type { AgentSessionId, WorktreeId } from "@/ipc/types";

type UiState = {
  selectedWorktreeId: WorktreeId | null;
  focusMode: boolean;
  worktreeSidebarCollapsed: boolean;
  /// Which agent tab is currently active per worktree. AgentPane writes
  /// it as the user clicks tabs; comment-send code reads it to route
  /// payloads to the right session.
  activeAgentByWorktree: Record<WorktreeId, AgentSessionId | null>;
  selectWorktree: (id: WorktreeId | null) => void;
  toggleFocusMode: () => void;
  setFocusMode: (on: boolean) => void;
  toggleWorktreeSidebar: () => void;
  setWorktreeSidebarCollapsed: (on: boolean) => void;
  setActiveAgent: (
    worktreeId: WorktreeId,
    agentId: AgentSessionId | null,
  ) => void;
  reset: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  selectedWorktreeId: null,
  focusMode: false,
  worktreeSidebarCollapsed: false,
  activeAgentByWorktree: {},
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
  setActiveAgent(worktreeId, agentId) {
    set((s) => ({
      activeAgentByWorktree: {
        ...s.activeAgentByWorktree,
        [worktreeId]: agentId,
      },
    }));
  },
  reset() {
    set({
      selectedWorktreeId: null,
      focusMode: false,
      worktreeSidebarCollapsed: false,
      activeAgentByWorktree: {},
    });
  },
}));
