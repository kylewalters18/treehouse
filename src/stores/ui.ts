import { create } from "zustand";
import type { AppFileKind } from "@/ipc/client";
import type { AgentSessionId, WorkspaceId, WorktreeId } from "@/ipc/types";
import type { ChangeGroup } from "./diffs";

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
  /// Which list the DiffPane sidebar shows: the changed-files list or
  /// the full worktree file tree. One at a time, not stacked.
  diffSidebarTab: "changes" | "files";
  /// Collapsed state of the Uncommitted / Branch groups in the
  /// Changes tab. App-wide, not per worktree.
  collapsedChangeGroups: Record<ChangeGroup, boolean>;
  /// Monotonic one-shot intent for "launch a new agent". Agent tabs
  /// live in AgentPane-local state, so the Cmd+Shift+A global shortcut
  /// can't create one directly — it bumps this counter and the mounted
  /// AgentPane (for the active worktree) reacts by running its launch
  /// handler. Carries no payload: the pane launches with whatever
  /// backend its dropdown currently shows, same as clicking "+".
  agentLaunchNonce: number;
  /// Worktrees that should launch the default agent the first time their
  /// AgentPane mounts (set by the New Worktree "Start default agent"
  /// option). One-shot: AgentPane consumes the entry after adoption, and
  /// only launches if the worktree has no agents yet.
  pendingAgentLaunch: Record<WorktreeId, true>;
  /// Which workspace the New Worktree dialog is open for, if any. Lifted
  /// out of WorktreeSidebar-local state so the Cmd+Shift+N global
  /// shortcut can open it for the active workspace.
  newWorktreeWorkspace: WorkspaceId | null;
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
  setDiffSidebarTab: (tab: "changes" | "files") => void;
  toggleChangeGroup: (group: ChangeGroup) => void;
  toggleProblemsTab: () => void;
  requestAgentLaunch: () => void;
  requestAgentLaunchFor: (worktreeId: WorktreeId) => void;
  /// Clears the pending flag; returns whether one was set.
  consumePendingAgentLaunch: (worktreeId: WorktreeId) => boolean;
  openNewWorktreeDialog: (workspaceId: WorkspaceId) => void;
  closeNewWorktreeDialog: () => void;
  reset: () => void;
};

export const useUiStore = create<UiState>((set, get) => ({
  selectedWorktreeId: null,
  focusMode: false,
  worktreeSidebarCollapsed: false,
  showIgnored: false,
  activeAgentByWorktree: {},
  agentLabelsBySessionId: {},
  agentTabOrderByWorktree: {},
  systemFileViewer: null,
  bottomPaneTab: "terminal",
  diffSidebarTab: "files",
  collapsedChangeGroups: { branch: false, uncommitted: false },
  agentLaunchNonce: 0,
  pendingAgentLaunch: {},
  newWorktreeWorkspace: null,
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
  setDiffSidebarTab(tab) {
    set({ diffSidebarTab: tab });
  },
  toggleChangeGroup(group) {
    set((s) => ({
      collapsedChangeGroups: {
        ...s.collapsedChangeGroups,
        [group]: !s.collapsedChangeGroups[group],
      },
    }));
  },
  toggleProblemsTab() {
    set((s) => ({
      bottomPaneTab: s.bottomPaneTab === "problems" ? "terminal" : "problems",
    }));
  },
  requestAgentLaunch() {
    set((s) => ({ agentLaunchNonce: s.agentLaunchNonce + 1 }));
  },
  requestAgentLaunchFor(worktreeId) {
    set((s) => ({
      pendingAgentLaunch: { ...s.pendingAgentLaunch, [worktreeId]: true },
    }));
  },
  consumePendingAgentLaunch(worktreeId) {
    if (!get().pendingAgentLaunch[worktreeId]) return false;
    set((s) => {
      const { [worktreeId]: _, ...rest } = s.pendingAgentLaunch;
      return { pendingAgentLaunch: rest };
    });
    return true;
  },
  openNewWorktreeDialog(workspaceId) {
    set({ newWorktreeWorkspace: workspaceId });
  },
  closeNewWorktreeDialog() {
    set({ newWorktreeWorkspace: null });
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
      diffSidebarTab: "files",
      collapsedChangeGroups: { branch: false, uncommitted: false },
      agentLaunchNonce: 0,
      pendingAgentLaunch: {},
      newWorktreeWorkspace: null,
    });
  },
}));
