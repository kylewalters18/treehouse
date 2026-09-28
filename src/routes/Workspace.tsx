import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { FileFinder } from "@/components/FileFinder";
import { CommandPalette } from "@/components/CommandPalette";
import { SystemFileViewer } from "@/components/SystemFileViewer";
import { AgentBoard, AgentBoardPill } from "@/components/AgentBoard";
import { ScratchAgent, ScratchPill } from "@/components/ScratchAgent";
import { StatusBar } from "@/components/StatusBar";
import { effectiveBaseRef } from "@/lib/base-ref";
import { Search, X } from "lucide-react";

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
  const setSidebarCollapsed = useUiStore((s) => s.setWorktreeSidebarCollapsed);
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const sidebarPanelReadyRef = useRef(false);
  // react-resizable-panels v2 sizes in percent only, so a fixed-width
  // collapsed rail means re-deriving its percentage from the group's
  // width. Changing `collapsedSize` while collapsed re-lays out the panel.
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const [railPct, setRailPct] = useState(() => railPercent(window.innerWidth));
  useLayoutEffect(() => {
    const el = panelBodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setRailPct(railPercent(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  // Multi-repo: the "active" workspace is whichever owns the selected
  // worktree. Falls back to the first open workspace when nothing is
  // selected (fresh launch before the user has clicked anywhere).
  const selectedWorktree =
    worktrees.find((w) => w.id === selectedWorktreeId) ?? null;
  // Subscribed (not `workspaceForWorktree`, which reads a snapshot) so
  // the title bar re-renders when e.g. the base-ref override changes.
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspace =
    workspaces.find((w) => w.id === selectedWorktree?.workspaceId) ??
    workspaces[0] ??
    null;
  const toggleProblemsTab = useUiStore((s) => s.toggleProblemsTab);
  // Bottom-pane maximize = collapse the diff above it. Store → Panel here;
  // Panel → store via onCollapse/onExpand so dragging the handle to the
  // top edge reads as maximized too.
  const bottomMaximized = useUiStore((s) => s.bottomPaneMaximized);
  const diffPanelRef = useRef<ImperativePanelHandle>(null);
  const setBottomMaximized = (on: boolean) => {
    if (useUiStore.getState().bottomPaneMaximized !== on) {
      useUiStore.getState().toggleBottomPaneMaximized();
    }
  };
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const panel = diffPanelRef.current;
      if (!panel) return;
      if (bottomMaximized && !panel.isCollapsed()) panel.collapse();
      if (!bottomMaximized && panel.isCollapsed()) panel.expand();
    });
    return () => cancelAnimationFrame(id);
  }, [bottomMaximized, focusMode]);
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
    sidebarPanelReadyRef.current = false;
    const id = requestAnimationFrame(() => {
      const panel = sidebarPanelRef.current;
      if (!panel) return;
      if (sidebarCollapsed) panel.collapse();
      else panel.expand();
      sidebarPanelReadyRef.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, [sidebarCollapsed, focusMode]);

  // The other direction: dragging the handle past `minSize` collapses
  // (or drags it back open) inside the library, so mirror that into the
  // store or the sidebar keeps rendering its full layout in the rail.
  // Ignored until the effect above has re-asserted the store's state —
  // a freshly mounted Panel reports its autosaved size first, which
  // would otherwise overwrite the store.
  const onSidebarCollapse = () => {
    if (sidebarPanelReadyRef.current) setSidebarCollapsed(true);
  };
  const onSidebarExpand = () => {
    if (sidebarPanelReadyRef.current) setSidebarCollapsed(false);
  };

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

  // ⌘K — agent board overlay. Capture phase so it wins everywhere,
  // including Monaco, which would otherwise swallow ⌘K as the start of a
  // chord (⌘K ⌘0 fold all, …) — we deliberately give those up. Cmd only:
  // Ctrl+K is kill-to-end-of-line in shells and agent inputs.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      if (e.key !== "k" && e.key !== "K") return;
      e.preventDefault();
      e.stopPropagation();
      useUiStore.getState().toggleAgentBoard();
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
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
      } else if (e.metaKey && !e.shiftKey && (e.key === "j" || e.key === "J")) {
        // ⌘J — scratch agent popup. Cmd only: Ctrl+J is a newline in
        // Claude's input (and LF in shells), so it must reach the xterm.
        e.preventDefault();
        useUiStore.getState().toggleScratch();
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
      {/* Overlay title bar (tauri.conf `titleBarStyle: Overlay`): the
          macOS traffic lights float over the left 80px, and every
          non-interactive element carries `data-tauri-drag-region` so the
          window drags from any empty patch of the strip. */}
      <header
        data-tauri-drag-region
        className="grid h-[38px] shrink-0 grid-cols-[1fr_minmax(16rem,26rem)_1fr] items-center gap-3 border-b border-neutral-800 bg-chrome pl-20 pr-2 text-xs"
      >
        <div
          data-tauri-drag-region
          className="flex min-w-0 items-center gap-2 text-neutral-500"
        >
          {activeWorkspace && (
            <>
              <span
                data-tauri-drag-region
                className="truncate font-medium text-neutral-100"
                title={activeWorkspace.root}
              >
                {repoLabel(activeWorkspace.root)}
              </span>
              {selectedWorktree && !selectedWorktree.isMainClone && (
                <>
                  <span data-tauri-drag-region className="text-neutral-600">
                    /
                  </span>
                  <span
                    data-tauri-drag-region
                    className="truncate font-mono text-[11.5px] text-neutral-200"
                  >
                    {selectedWorktree.branch}
                  </span>
                </>
              )}
              {/* On a worktree: the ref its branch diff compares against
                  (tracks the diff pane's base-ref picker). On the main
                  clone: just the checked-out default branch. */}
              <span
                data-tauri-drag-region
                className="shrink-0 rounded border border-neutral-800 bg-neutral-900 px-1.5 font-mono text-[10.5px] leading-[18px] text-neutral-400"
                title={
                  selectedWorktree && !selectedWorktree.isMainClone
                    ? "Diff base — change it from the Branch section of the Changes list"
                    : undefined
                }
              >
                {selectedWorktree && !selectedWorktree.isMainClone
                  ? `vs ${effectiveBaseRef(activeWorkspace)}`
                  : activeWorkspace.defaultBranch}
              </span>
            </>
          )}
        </div>
        <button
          onClick={() => setCommandPaletteOpen(true)}
          className="flex h-6 items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-2 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
          title="Command palette (⌘⇧P)"
        >
          <Search size={13} className="shrink-0" />
          <span className="flex-1 truncate text-left">
            Search commands, files, worktrees
          </span>
          <kbd className="rounded border border-neutral-700 bg-neutral-950 px-1 font-sans text-[10px] leading-4 text-neutral-500">
            ⌘⇧P
          </kbd>
        </button>
        <div
          data-tauri-drag-region
          className="flex items-center justify-end gap-1.5"
        >
          <AgentBoardPill />
          <ScratchPill />
          <SettingsMenu />
          <button
            onClick={() => {
              if (activeWorkspace) void closeWorkspace(activeWorkspace.id);
            }}
            disabled={!activeWorkspace}
            title="Close this repo (other open repos stay open)"
            aria-label="Close"
            className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-50"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div ref={panelBodyRef} className="flex min-h-0 flex-1">
        {focusMode ? (
          <PanelGroup
            key="focus"
            direction="horizontal"
            className="min-h-0 flex-1"
            autoSaveId="layout-focus"
          >
            <Panel
              ref={sidebarPanelRef}
              defaultSize={14}
              minSize={10}
              collapsible
              collapsedSize={railPct}
              onCollapse={onSidebarCollapse}
              onExpand={onSidebarExpand}
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
            className="min-h-0 flex-1"
            autoSaveId="layout-normal"
          >
            <Panel
              id="sidebar"
              order={1}
              ref={sidebarPanelRef}
              defaultSize={18}
              minSize={14}
              collapsible
              collapsedSize={railPct}
              onCollapse={onSidebarCollapse}
              onExpand={onSidebarExpand}
            >
              <WorktreeSidebar />
            </Panel>
            <PanelResizeHandle className="w-px bg-neutral-800 hover:bg-neutral-700" />
            <Panel id="center" order={2} defaultSize={48}>
              <PanelGroup direction="vertical" autoSaveId="center-normal">
                <Panel
                  ref={diffPanelRef}
                  defaultSize={60}
                  collapsible
                  collapsedSize={0}
                  onCollapse={() => setBottomMaximized(true)}
                  onExpand={() => setBottomMaximized(false)}
                >
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
      </div>
      <StatusBar
        worktree={selectedWorktree}
        defaultBranch={activeWorkspace?.defaultBranch ?? null}
      />
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
      <AgentBoard />
      <ScratchAgent />
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


/// Last path segment of a repo root — the breadcrumb shows the repo's
/// name; the full path lives in the tooltip.
/// Collapsed worktree rail width, in px.
const RAIL_PX = 40;

function railPercent(groupWidth: number): number {
  return Math.min(10, (RAIL_PX / groupWidth) * 100);
}

function repoLabel(root: string): string {
  return root.split("/").filter(Boolean).pop() ?? root;
}
