import { create } from "zustand";
import type { AppFileKind } from "@/ipc/client";
import type { AgentSessionId, WorktreeId } from "@/ipc/types";

type UiState = {
  selectedWorktreeId: WorktreeId | null;
  focusMode: boolean;
  worktreeSidebarCollapsed: boolean;
  /// Workspace-wide toggle: when true, gitignored entries are surfaced
  /// in the file tree (dimmed) and the Cmd+P fuzzy finder. Default off.
  /// `BUILTIN_IGNORES` (`.git`, `node_modules`, …) always applies.
  showIgnored: boolean;
  /// Which agent tab is currently active per worktree. AgentPane writes
  /// it as the user clicks tabs; comment-send code reads it to route
  /// payloads to the right session.
  activeAgentByWorktree: Record<WorktreeId, AgentSessionId | null>;
  /// Per-session display label as the AgentPane shows it on tabs (e.g.
  /// "Claude 1" or "Claude 1 (rust-analyzer)"). The numeric counter is
  /// AgentPane-local state, so consumers like SendTargetPopover need
  /// AgentPane to publish the rendered label to share it.
  agentLabelsBySessionId: Record<AgentSessionId, string>;
  /// User-set agent-tab order per worktree, as a list of session IDs.
  /// AgentPane writes this when the user drags a tab; on worktree switch
  /// it remounts and consults this list to lay tabs out in the same
  /// order. Sessions absent from the list (newly launched, or stored
  /// state predates the launch) sort to the end in their original
  /// `started_at` order.
  agentTabOrderByWorktree: Record<WorktreeId, AgentSessionId[]>;
  /// Which app-managed system file the in-app viewer modal is
  /// showing, if any. Set by command-palette entries; consumed by
  /// the modal mount in `Workspace`.
  systemFileViewer: AppFileKind | null;
  /// Which tab the bottom pane (terminal / problems) is showing.
  /// VS Code-style — both views share the same panel space; the
  /// terminal stays mounted (with its sessions alive) when the
  /// user flips to Problems and back.
  bottomPaneTab: "terminal" | "problems" | "review" | "ci";
  selectWorktree: (id: WorktreeId | null) => void;
  toggleFocusMode: () => void;
  setFocusMode: (on: boolean) => void;
  toggleWorktreeSidebar: () => void;
  setWorktreeSidebarCollapsed: (on: boolean) => void;
  setShowIgnored: (on: boolean) => void;
  setActiveAgent: (
    worktreeId: WorktreeId,
    agentId: AgentSessionId | null,
  ) => void;
  setAgentLabel: (agentId: AgentSessionId, label: string) => void;
  clearAgentLabel: (agentId: AgentSessionId) => void;
  setAgentTabOrder: (
    worktreeId: WorktreeId,
    sessionIds: AgentSessionId[],
  ) => void;
  openSystemFileViewer: (kind: AppFileKind) => void;
  closeSystemFileViewer: () => void;
  setBottomPaneTab: (tab: "terminal" | "problems" | "review" | "ci") => void;
  toggleProblemsTab: () => void;
  reset: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  selectedWorktreeId: null,
  focusMode: false,
  worktreeSidebarCollapsed: false,
  showIgnored: false,
  activeAgentByWorktree: {},
  agentLabelsBySessionId: {},
  agentTabOrderByWorktree: {},
  systemFileViewer: null,
  bottomPaneTab: "terminal",
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
  setShowIgnored(on) {
    set({ showIgnored: on });
  },
  setActiveAgent(worktreeId, agentId) {
    set((s) => ({
      activeAgentByWorktree: {
        ...s.activeAgentByWorktree,
        [worktreeId]: agentId,
      },
    }));
  },
  setAgentLabel(agentId, label) {
    set((s) => ({
      agentLabelsBySessionId: {
        ...s.agentLabelsBySessionId,
        [agentId]: label,
      },
    }));
  },
  clearAgentLabel(agentId) {
    set((s) => {
      const next = { ...s.agentLabelsBySessionId };
      delete next[agentId];
      return { agentLabelsBySessionId: next };
    });
  },
  setAgentTabOrder(worktreeId, sessionIds) {
    set((s) => ({
      agentTabOrderByWorktree: {
        ...s.agentTabOrderByWorktree,
        [worktreeId]: sessionIds,
      },
    }));
  },
  openSystemFileViewer(kind) {
    set({ systemFileViewer: kind });
  },
  closeSystemFileViewer() {
    set({ systemFileViewer: null });
  },
  setBottomPaneTab(tab) {
    set({ bottomPaneTab: tab });
  },
  toggleProblemsTab() {
    set((s) => ({
      bottomPaneTab: s.bottomPaneTab === "problems" ? "terminal" : "problems",
    }));
  },
  reset() {
    set({
      selectedWorktreeId: null,
      focusMode: false,
      worktreeSidebarCollapsed: false,
      showIgnored: false,
      activeAgentByWorktree: {},
      agentLabelsBySessionId: {},
      agentTabOrderByWorktree: {},
      systemFileViewer: null,
      bottomPaneTab: "terminal",
    });
  },
}));
