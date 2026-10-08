import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { AppFileKind } from "@/ipc/client";
import type { AgentSessionId, ForgeIssue, WorkspaceId, WorktreeId } from "@/ipc/types";
import type { ChangeGroup } from "./diffs";

/// Devices the Browser tab can emulate: viewport size in CSS px.
export const BROWSER_DEVICES = {
  "iphone-16-pro": { label: "iPhone 16 Pro", width: 402, height: 874 },
} as const;

export type BrowserDeviceId = keyof typeof BROWSER_DEVICES;

/// A queued first launch for a new worktree's AgentPane.
export type PendingAgentLaunch = { prompt?: string };

export type WidePane = "code" | "agent";

export type BottomPaneTab = "terminal" | "browser" | "problems" | "review" | "ci";

type UiState = {
  selectedWorktreeId: WorktreeId | null;
  /// Diff takes over the whole center column (bottom pane collapsed).
  /// Mirror of `bottomPaneMaximized`; sidebar and agent pane stay put.
  focusMode: boolean;
  /// Which side of the code | agent split is widened (⌘⌥← / ⌘⌥→). The
  /// other side shrinks to a peek strip rather than collapsing.
  widePane: WidePane | null;
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
  bottomPaneTab: BottomPaneTab;
  /// Bottom pane takes over the whole center column (diff collapsed).
  /// Mostly for the Browser tab, where the default split is too small
  /// to judge a UI, but it applies to every tab.
  bottomPaneMaximized: boolean;
  /// URL the Browser tab shows per worktree. In-memory only — worktree
  /// IDs aren't stable across restarts.
  browserUrlByWorktree: Record<WorktreeId, string>;
  /// Browser-tab viewport: fill the pane, or emulate a device's screen
  /// size (see `BROWSER_DEVICES`). App-wide, not per worktree.
  browserDevice: BrowserDeviceId | null;
  /// Which list the DiffPane sidebar shows: the changed-files list or
  /// the full worktree file tree. One at a time, not stacked.
  diffSidebarTab: "changes" | "files" | "history";
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
  /// only launches if the worktree has no agents yet. `prompt` becomes the
  /// agent's first message (create-from-issue seeds it with the issue).
  pendingAgentLaunch: Record<WorktreeId, PendingAgentLaunch>;
  /// Which workspace the New Worktree dialog is open for, if any. Lifted
  /// out of WorktreeSidebar-local state so the Cmd+Shift+N global
  /// shortcut can open it for the active workspace.
  newWorktreeWorkspace: WorkspaceId | null;
  /// An issue to preselect when the dialog opens (the planner's issue drawer).
  newWorktreeIssue: ForgeIssue | null;
  /// Agent board overlay (⌘K).
  agentBoardOpen: boolean;
  agentBoardLayout: "board" | "list";
  /// ⌘J planner popup (a repo's planner, or the global scratch agent).
  plannerOpen: boolean;
  /// A planner the user picked by hand in the popup, sticky while they stay
  /// in `forRepo` (the repo they were in when picking); `scope` null =
  /// global. Cleared implicitly once they move to another repo.
  plannerPick: { scope: WorkspaceId | null; forRepo: WorkspaceId | null } | null;
  /// The planner popup's issue drawer.
  plannerIssuesOpen: boolean;
  /// Epoch ms each agent session was last on screen — its tab active in
  /// the selected worktree. Maintained by the subscription below; the
  /// board uses it to tell finished-and-unseen turns from seen ones.
  agentSeenAt: Record<AgentSessionId, number>;
  /// One-shot request for the mounted AgentPane to switch to a tab.
  /// Needed when the target worktree is already selected: AgentTabs
  /// only reads `activeAgentByWorktree` when it mounts.
  agentFocusRequest: { agentId: AgentSessionId; nonce: number } | null;
  /// Show resolved review comments inline in the editor / diff. Toggled
  /// from the file header; read by CommentOverlay.
  showResolvedComments: boolean;
  /// One-shot request from the file header for the mounted CommentOverlay
  /// on `path` to open a whole-file comment composer.
  fileCommentRequest: { worktreeId: WorktreeId; path: string; nonce: number } | null;
  selectWorktree: (id: WorktreeId | null) => void;
  toggleFocusMode: () => void;
  setFocusMode: (on: boolean) => void;
  /// Widen `side`, or restore the split if it's already widened.
  toggleWidePane: (side: WidePane) => void;
  setWidePane: (side: WidePane | null) => void;
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
  setBottomPaneTab: (tab: BottomPaneTab) => void;
  toggleBottomPaneMaximized: () => void;
  /// Record the URL a preview is on (after in-page navigation). Doesn't
  /// navigate — see `navigateBrowser`.
  setBrowserUrl: (worktreeId: WorktreeId, url: string) => void;
  /// Point `worktreeId`'s preview at `url`.
  navigateBrowser: (worktreeId: WorktreeId, url: string) => void;
  /// `navigateBrowser`, then switch the bottom pane to the Browser tab.
  openInBrowser: (worktreeId: WorktreeId, url: string) => void;
  setBrowserDevice: (device: BrowserDeviceId | null) => void;
  /// Drop a worktree's preview (the worktree is gone).
  closeBrowser: (worktreeId: WorktreeId) => void;
  setDiffSidebarTab: (tab: "changes" | "files" | "history") => void;
  toggleChangeGroup: (group: ChangeGroup) => void;
  toggleProblemsTab: () => void;
  requestAgentLaunch: () => void;
  requestAgentLaunchFor: (worktreeId: WorktreeId, prompt?: string) => void;
  /// Clears the pending request and returns it, or null if none was set.
  consumePendingAgentLaunch: (worktreeId: WorktreeId) => PendingAgentLaunch | null;
  openNewWorktreeDialog: (workspaceId: WorkspaceId, issue?: ForgeIssue) => void;
  closeNewWorktreeDialog: () => void;
  setAgentBoardOpen: (open: boolean) => void;
  toggleAgentBoard: () => void;
  setPlannerOpen: (open: boolean) => void;
  togglePlanner: () => void;
  setPlannerPick: (pick: { scope: WorkspaceId | null; forRepo: WorkspaceId | null }) => void;
  setPlannerIssuesOpen: (open: boolean) => void;
  setAgentBoardLayout: (layout: "board" | "list") => void;
  markAgentSeen: (agentId: AgentSessionId) => void;
  /// Select `worktreeId` and make `agentId` its active agent tab.
  focusAgent: (worktreeId: WorktreeId, agentId: AgentSessionId) => void;
  toggleShowResolvedComments: () => void;
  requestFileComment: (worktreeId: WorktreeId, path: string) => void;
  clearFileCommentRequest: () => void;
  reset: () => void;
};

export const useUiStore = create<UiState>((set, get) => ({
  selectedWorktreeId: null,
  focusMode: false,
  widePane: null,
  worktreeSidebarCollapsed: false,
  showIgnored: false,
  activeAgentByWorktree: {},
  agentLabelsBySessionId: {},
  agentTabOrderByWorktree: {},
  systemFileViewer: null,
  bottomPaneTab: "terminal",
  bottomPaneMaximized: false,
  browserUrlByWorktree: {},
  browserDevice: null,
  diffSidebarTab: "files",
  collapsedChangeGroups: { branch: false, uncommitted: false, commit: false },
  agentLaunchNonce: 0,
  pendingAgentLaunch: {},
  newWorktreeWorkspace: null,
  newWorktreeIssue: null,
  agentBoardOpen: false,
  agentBoardLayout: "board",
  plannerOpen: false,
  plannerPick: null,
  plannerIssuesOpen: false,
  agentSeenAt: {},
  agentFocusRequest: null,
  showResolvedComments: false,
  fileCommentRequest: null,
  selectWorktree(id) {
    set({ selectedWorktreeId: id });
  },
  // Focus mode (diff takes the center column) and bottom-pane maximize
  // (bottom pane takes it) are mirror images — entering one leaves the other.
  toggleFocusMode() {
    set((s) =>
      s.focusMode
        ? { focusMode: false }
        : { focusMode: true, bottomPaneMaximized: false },
    );
  },
  setFocusMode(on) {
    set(on ? { focusMode: true, bottomPaneMaximized: false } : { focusMode: false });
  },
  toggleWidePane(side) {
    set((s) => ({ widePane: s.widePane === side ? null : side }));
  },
  setWidePane(side) {
    set({ widePane: side });
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
  toggleBottomPaneMaximized() {
    set((s) =>
      s.bottomPaneMaximized
        ? { bottomPaneMaximized: false }
        : { bottomPaneMaximized: true, focusMode: false },
    );
  },
  setBrowserUrl(worktreeId, url) {
    set((s) => ({
      browserUrlByWorktree: { ...s.browserUrlByWorktree, [worktreeId]: url },
    }));
  },
  navigateBrowser(worktreeId, url) {
    get().setBrowserUrl(worktreeId, url);
    // No-op if the webview doesn't exist yet; BrowserPanel creates it at
    // the stored URL when it's next shown.
    void ipc.browserNavigate(worktreeId, url).catch((e) => {
      console.warn("[browser] navigate failed", url, e);
    });
  },
  openInBrowser(worktreeId, url) {
    get().navigateBrowser(worktreeId, url);
    set({ bottomPaneTab: "browser" });
  },
  setBrowserDevice(device) {
    set({ browserDevice: device });
  },
  closeBrowser(worktreeId) {
    set((s) => {
      const { [worktreeId]: _, ...rest } = s.browserUrlByWorktree;
      return { browserUrlByWorktree: rest };
    });
    void ipc.browserClose(worktreeId).catch(() => {});
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
  requestAgentLaunchFor(worktreeId, prompt) {
    set((s) => ({
      pendingAgentLaunch: { ...s.pendingAgentLaunch, [worktreeId]: { prompt } },
    }));
  },
  consumePendingAgentLaunch(worktreeId) {
    const req = get().pendingAgentLaunch[worktreeId];
    if (!req) return null;
    set((s) => {
      const { [worktreeId]: _, ...rest } = s.pendingAgentLaunch;
      return { pendingAgentLaunch: rest };
    });
    return req;
  },
  openNewWorktreeDialog(workspaceId, issue) {
    set({ newWorktreeWorkspace: workspaceId, newWorktreeIssue: issue ?? null });
  },
  closeNewWorktreeDialog() {
    set({ newWorktreeWorkspace: null, newWorktreeIssue: null });
  },
  setAgentBoardOpen(open) {
    if (open) {
      // The agent on screen right now has been seen, even if its turn
      // ended while the user watched it.
      const visible = visibleAgent(get());
      if (visible) get().markAgentSeen(visible);
    }
    // One overlay at a time: the board and planner both want the keyboard.
    set(open ? { agentBoardOpen: true, plannerOpen: false } : { agentBoardOpen: false });
  },
  toggleAgentBoard() {
    get().setAgentBoardOpen(!get().agentBoardOpen);
  },
  setPlannerOpen(open) {
    // Hiding a planner only detaches its xterm, so closing it for the board
    // (and vice versa) loses nothing.
    set(open ? { plannerOpen: true, agentBoardOpen: false } : { plannerOpen: false });
  },
  setPlannerPick(pick) {
    set({ plannerPick: pick });
  },
  setPlannerIssuesOpen(open) {
    set({ plannerIssuesOpen: open });
  },
  togglePlanner() {
    get().setPlannerOpen(!get().plannerOpen);
  },
  setAgentBoardLayout(layout) {
    set({ agentBoardLayout: layout });
  },
  markAgentSeen(agentId) {
    set((s) => ({ agentSeenAt: { ...s.agentSeenAt, [agentId]: Date.now() } }));
  },
  focusAgent(worktreeId, agentId) {
    set((s) => ({
      activeAgentByWorktree: {
        ...s.activeAgentByWorktree,
        [worktreeId]: agentId,
      },
      agentFocusRequest: {
        agentId,
        nonce: (s.agentFocusRequest?.nonce ?? 0) + 1,
      },
      selectedWorktreeId: worktreeId,
    }));
  },
  toggleShowResolvedComments() {
    set((s) => ({ showResolvedComments: !s.showResolvedComments }));
  },
  requestFileComment(worktreeId, path) {
    set((s) => ({
      fileCommentRequest: {
        worktreeId,
        path,
        nonce: (s.fileCommentRequest?.nonce ?? 0) + 1,
      },
    }));
  },
  clearFileCommentRequest() {
    set({ fileCommentRequest: null });
  },
  reset() {
    set({
      selectedWorktreeId: null,
      focusMode: false,
      widePane: null,
      worktreeSidebarCollapsed: false,
      showIgnored: false,
      activeAgentByWorktree: {},
      agentLabelsBySessionId: {},
      agentTabOrderByWorktree: {},
      systemFileViewer: null,
      bottomPaneTab: "terminal",
      bottomPaneMaximized: false,
      browserUrlByWorktree: {},
      browserDevice: null,
      diffSidebarTab: "files",
      collapsedChangeGroups: { branch: false, uncommitted: false, commit: false },
      agentLaunchNonce: 0,
      pendingAgentLaunch: {},
      newWorktreeWorkspace: null,
      newWorktreeIssue: null,
      agentBoardOpen: false,
      agentBoardLayout: "board",
      agentSeenAt: {},
      agentFocusRequest: null,
      showResolvedComments: false,
      fileCommentRequest: null,
    });
  },
}));

/// The agent session on screen: the active tab of the selected worktree.
function visibleAgent(
  s: Pick<UiState, "selectedWorktreeId" | "activeAgentByWorktree">,
): AgentSessionId | null {
  return s.selectedWorktreeId
    ? (s.activeAgentByWorktree[s.selectedWorktreeId] ?? null)
    : null;
}

// Stamp `agentSeenAt` whenever the visible agent changes: the one being
// left (the user watched it up to now) and the one arriving.
useUiStore.subscribe((s, prev) => {
  const next = visibleAgent(s);
  const before = visibleAgent(prev);
  if (next === before) return;
  if (before) s.markAgentSeen(before);
  if (next) s.markAgentSeen(next);
});
