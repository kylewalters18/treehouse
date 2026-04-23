import { useEffect, useMemo, useRef } from "react";
import {
  PanelGroup,
  Panel,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import { useDiffsStore } from "@/stores/diffs";
import { useLspStore } from "@/stores/lsp";
import { useUiStore } from "@/stores/ui";
import { WorktreeSidebar } from "@/panels/WorktreeSidebar";
import { DiffPane } from "@/panels/DiffPane";
import { TerminalPane } from "@/panels/TerminalPane";
import { AgentPane } from "@/panels/AgentPane";
import { SettingsMenu } from "@/components/SettingsMenu";
import { SendQueueButton } from "@/components/SendQueueButton";

export function Workspace() {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const closeWorkspace = useWorkspaceStore((s) => s.closeWorkspace);
  const resetWorktrees = useWorktreesStore((s) => s.reset);
  const resetDiffs = useDiffsStore((s) => s.reset);
  const resetUi = useUiStore((s) => s.reset);
  const loadLspConfigs = useLspStore((s) => s.load);
  const focusMode = useUiStore((s) => s.focusMode);
  const toggleFocusMode = useUiStore((s) => s.toggleFocusMode);
  const sidebarCollapsed = useUiStore((s) => s.worktreeSidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleWorktreeSidebar);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId);
  const hideAgent = useMemo(() => {
    const sel = worktrees.find((w) => w.id === selectedWorktreeId);
    return sel?.isMainClone ?? false;
  }, [worktrees, selectedWorktreeId]);
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);

  // Reflect store state onto the Panel imperatively. Keeping state in the
  // store (not inside the Panel) lets the sidebar content + keyboard shortcut
  // both toggle from outside the Panel component.
  //
  // `focusMode` and `hideAgent` are in the deps because each toggle swaps
  // which PanelGroup (and therefore which Panel) is mounted — the ref points
  // at a fresh Panel at its default size, so we need to re-assert the
  // collapsed state so focus mode and sidebar collapse behave independently.
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
  }, [sidebarCollapsed, focusMode, hideAgent]);

  useEffect(() => {
    void loadLspConfigs();
    return () => {
      resetWorktrees();
      resetDiffs();
      resetUi();
    };
  }, [workspace, resetWorktrees, resetDiffs, resetUi, loadLspConfigs]);

  // Cmd+\ (Ctrl+\ on Linux/Win) toggles focus mode.
  // Cmd+B toggles the worktree sidebar (VS Code muscle memory).
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
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFocusMode, toggleSidebar]);

  if (!workspace) return null;

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold">treehouse</span>
          <span className="font-mono text-neutral-400">{workspace.root}</span>
          <span className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-[11px] text-neutral-300">
            {workspace.defaultBranch}
          </span>
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
            onClick={closeWorkspace}
            className="rounded border border-neutral-700 px-2 py-1 text-neutral-400 hover:bg-neutral-800"
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
        <PanelGroup
          key={hideAgent ? "normal-no-agent" : "normal"}
          direction="horizontal"
          className="flex-1"
          autoSaveId={hideAgent ? "layout-normal-no-agent" : "layout-normal"}
        >
          <Panel
            ref={sidebarPanelRef}
            defaultSize={18}
            minSize={14}
            collapsible
            collapsedSize={3}
          >
            <WorktreeSidebar />
          </Panel>
          <PanelResizeHandle className="w-px bg-neutral-800 hover:bg-neutral-700" />
          <Panel defaultSize={hideAgent ? 82 : 48}>
            <PanelGroup direction="vertical" autoSaveId="center-normal">
              <Panel defaultSize={60}>
                <DiffPane />
              </Panel>
              <PanelResizeHandle className="h-px bg-neutral-800 hover:bg-neutral-700" />
              <Panel defaultSize={40}>
                <TerminalPane />
              </Panel>
            </PanelGroup>
          </Panel>
          {!hideAgent && (
            <>
              <PanelResizeHandle className="w-px bg-neutral-800 hover:bg-neutral-700" />
              <Panel defaultSize={34} minSize={20}>
                <AgentPane />
              </Panel>
            </>
          )}
        </PanelGroup>
      )}
    </div>
  );
}
