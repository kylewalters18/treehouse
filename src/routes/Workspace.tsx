import { useEffect, useRef, useState } from "react";
import {
  PanelGroup,
  Panel,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { useWorkspaceStore, workspaceForWorktree } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import { useDiffsStore } from "@/stores/diffs";
import { useLspStore } from "@/stores/lsp";
import { useNavigationStore } from "@/stores/navigation";
import { useTerminalLayoutStore } from "@/stores/terminal-layout";
import { useUiStore } from "@/stores/ui";
import { WorktreeSidebar } from "@/panels/WorktreeSidebar";
import { DiffPane } from "@/panels/DiffPane";
import { BottomPane } from "@/panels/BottomPane";
import { AgentPane } from "@/panels/AgentPane";
import { SettingsMenu } from "@/components/SettingsMenu";
import { SendQueueButton } from "@/components/SendQueueButton";
import { FileFinder } from "@/components/FileFinder";
import { CommandPalette } from "@/components/CommandPalette";
import { SystemFileViewer } from "@/components/SystemFileViewer";

export function Workspace() {
  const workspaceCount = useWorkspaceStore((s) => s.workspaces.length);
  const closeWorkspace = useWorkspaceStore((s) => s.closeWorkspace);
  const resetWorktrees = useWorktreesStore((s) => s.reset);
  const resetDiffs = useDiffsStore((s) => s.reset);
  const resetUi = useUiStore((s) => s.reset);
  const loadLspConfigs = useLspStore((s) => s.load);
  const focusMode = useUiStore((s) => s.focusMode);
  const toggleFocusMode = useUiStore((s) => s.toggleFocusMode);
  const sidebarCollapsed = useUiStore((s) => s.worktreeSidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleWorktreeSidebar);
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  // Multi-repo: the "active" workspace is whichever owns the selected
  // worktree. Falls back to the first open workspace when nothing is
  // selected (fresh launch before the user has clicked anywhere).
  const selectedWorktree =
    worktrees.find((w) => w.id === selectedWorktreeId) ?? null;
  const activeWorkspace =
    workspaceForWorktree(selectedWorktree?.workspaceId) ??
    useWorkspaceStore.getState().workspaces[0] ??
    null;
  const toggleProblemsTab = useUiStore((s) => s.toggleProblemsTab);
  // Cmd+P "Go to file" picker. Open state lives here so the
  // shortcut works regardless of which pane has focus.
  const [fileFinderOpen, setFileFinderOpen] = useState(false);
  // Cmd+Shift+P command palette — same global ownership as Cmd+P.
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Reflect store state onto the Panel imperatively. Keeping state in the
  // store (not inside the Panel) lets the sidebar content + keyboard shortcut
  // both toggle from outside the Panel component.
  //
  // `focusMode` is in the deps because toggling it swaps which PanelGroup
  // (and therefore which Panel) is mounted — the ref points at a fresh
  // Panel at its default size, so we need to re-assert the collapsed state.
  //
  // The rAF defer is because react-resizable-panels' imperative API doesn't
  // take effect if called before the newly-mounted Panel has registered with
  // its PanelGroup. Running on the next frame ensures registration is done.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const panel = sidebarPanelRef.current;
      if (!panel) return;
      if (sidebarCollapsed) panel.collapse();
      else panel.expand();
    });
    return () => cancelAnimationFrame(id);
  }, [sidebarCollapsed, focusMode]);

  useEffect(() => {
    void loadLspConfigs();
    // Reset only when leaving the Workspace shell entirely (all repos
    // closed → Home). With multi-repo, opening another repo MUST NOT
    // reset worktrees/diffs/ui — they're shared across all open
    // workspaces and keyed by worktreeId.
    return () => {
      resetWorktrees();
      resetDiffs();
      resetUi();
    };
    // Intentionally empty deps: only the unmount path runs the reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cmd+\ (Ctrl+\ on Linux/Win) toggles focus mode.
  // Cmd+B toggles the worktree sidebar (VS Code muscle memory).
  // Cmd+P opens the fuzzy file finder; Cmd+Shift+P opens the command
  // palette (also VS Code muscle memory).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "\\") {
        e.preventDefault();
        toggleFocusMode();
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        if (e.shiftKey) {
          setCommandPaletteOpen((v) => !v);
        } else {
          // Skip the file picker on the main clone — the diff pane is
          // showing the main repo's checkout, not a worktree's, so
          // there's no clear "open in editor" target. The command
          // palette stays available regardless.
          if (!selectedWorktreeId) return;
          setFileFinderOpen((v) => !v);
        }
      } else if (e.shiftKey && (e.key === "m" || e.key === "M")) {
        // Cmd+Shift+M — flip the bottom pane to/from Problems
        // (matches VS Code's shortcut). If the pane is collapsed
        // the user still needs to drag it open; auto-expanding it
        // is a follow-up.
        e.preventDefault();
        toggleProblemsTab();
      } else if (e.key === "[" || e.key === "]") {
        // ⌘[ / ⌘] — browser-style back / forward through the
        // per-worktree cursor-position history. No-op when no
        // worktree is selected (main-clone view) or the stack
        // can't move in that direction.
        if (!selectedWorktreeId) return;
        e.preventDefault();
        const nav = useNavigationStore.getState();
        if (e.key === "[") nav.back(selectedWorktreeId);
        else nav.forward(selectedWorktreeId);
      } else if (!e.shiftKey && (e.key === "t" || e.key === "T")) {
        // ⌘T — new terminal tab in the active worktree.
        if (!selectedWorktreeId) return;
        e.preventDefault();
        useTerminalLayoutStore.getState().addTab(selectedWorktreeId);
      } else if (e.shiftKey && (e.key === "a" || e.key === "A")) {
        // ⌘⇧A — new agent tab (AgentPane reacts to the launch nonce).
        if (!selectedWorktreeId) return;
        e.preventDefault();
        useUiStore.getState().requestAgentLaunch();
      } else if (e.shiftKey && (e.key === "n" || e.key === "N")) {
        // ⌘⇧N — new worktree in the active (or first open) workspace.
        e.preventDefault();
        const wt = useWorktreesStore
          .getState()
          .worktrees.find((w) => w.id === selectedWorktreeId);
        const ws =
          workspaceForWorktree(wt?.workspaceId) ??
          useWorkspaceStore.getState().workspaces[0] ??
          null;
        if (ws) useUiStore.getState().openNewWorktreeDialog(ws.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFocusMode, toggleSidebar, selectedWorktreeId, toggleProblemsTab]);

  if (workspaceCount === 0) return null;

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold">treehouse</span>
          {activeWorkspace && (
            <>
              <span className="font-mono text-neutral-400">
                {activeWorkspace.root}
              </span>
              <span className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-[11px] text-neutral-300">
                {activeWorkspace.defaultBranch}
              </span>
            </>
          )}
          {focusMode && (
            <span className="rounded bg-blue-900/40 px-2 py-0.5 font-mono text-[11px] text-blue-300">
              focus · ⌘\ to exit
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <SendQueueButton />
          <SettingsMenu />
          <button
            onClick={() => {
              if (activeWorkspace) void closeWorkspace(activeWorkspace.id);
            }}
            disabled={!activeWorkspace}
            title="Close this repo (other open repos stay open)"
            className="rounded border border-neutral-700 px-2 py-1 text-neutral-400 hover:bg-neutral-800 disabled:opacity-50"
          >
            Close
          </button>
        </div>
      </header>

      {focusMode ? (
        <PanelGroup
          key="focus"
          direction="horizontal"
          className="flex-1"
          autoSaveId="layout-focus"
        >
          <Panel
            ref={sidebarPanelRef}
            defaultSize={14}
            minSize={10}
            collapsible
            collapsedSize={3}
          >
            <WorktreeSidebar />
          </Panel>
          <PanelResizeHandle className="w-px bg-neutral-800 hover:bg-neutral-700" />
          <Panel defaultSize={86}>
            <DiffPane />
          </Panel>
        </PanelGroup>
      ) : (
        // Single PanelGroup across main-clone and worktree selections so
        // the sidebar keeps its user-dragged width when switching between
        // them. Previously we swapped PanelGroups via `key`, which
        // remounted the sidebar and reset its width to `defaultSize`
        // every time the user clicked the main clone. react-resizable-
        // panels v2 handles the conditionally-rendered Agent pane as
        // long as each Panel carries a stable `id` + `order`.
        <PanelGroup
          direction="horizontal"
          className="flex-1"
          autoSaveId="layout-normal"
        >
          <Panel
            id="sidebar"
            order={1}
            ref={sidebarPanelRef}
            defaultSize={18}
            minSize={14}
            collapsible
            collapsedSize={3}
          >
            <WorktreeSidebar />
          </Panel>
          <PanelResizeHandle className="w-px bg-neutral-800 hover:bg-neutral-700" />
          <Panel id="center" order={2} defaultSize={48}>
            <PanelGroup direction="vertical" autoSaveId="center-normal">
              <Panel defaultSize={60}>
                <DiffPane />
              </Panel>
              <PanelResizeHandle className="h-px bg-neutral-800 hover:bg-neutral-700" />
              <Panel defaultSize={40}>
                <BottomPane />
              </Panel>
            </PanelGroup>
          </Panel>
          <PanelResizeHandle className="w-px bg-neutral-800 hover:bg-neutral-700" />
          {/* Agent panel stays mounted on main clone too — AgentPane
              renders an empty placeholder when on the main clone, but
              the panel group's widths stay stable across main/worktree
              switches that way. Conditionally removing this Panel
              triggered react-resizable-panels' proportional reflow,
              which drifted the sidebar's width on every flip. */}
          <Panel id="agent" order={3} defaultSize={34} minSize={20}>
            <AgentPane />
          </Panel>
        </PanelGroup>
      )}
      {selectedWorktreeId && (
        <FileFinder
          worktreeId={selectedWorktreeId}
          open={fileFinderOpen}
          onClose={() => setFileFinderOpen(false)}
        />
      )}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />
      <SystemFileViewerMount />
    </div>
  );
}

/// Render the system-file viewer modal driven by the UI store.
/// Pulled out so the store subscription lives in its own component
/// and a viewer-state change doesn't re-render the whole Workspace
/// tree.
function SystemFileViewerMount() {
  const kind = useUiStore((s) => s.systemFileViewer);
  const close = useUiStore((s) => s.closeSystemFileViewer);
  if (!kind) return null;
  return <SystemFileViewer open={true} onClose={close} kind={kind} />;
}

