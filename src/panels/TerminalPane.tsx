import { iconButton, instanceStrip, instanceTab, instanceTabClose } from "@/lib/pane-chrome";
import { Columns2, Plus, Rows2, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

import { useUiStore } from "@/stores/ui";
import { useActivityStore } from "@/stores/activity";
import { commandLabel, formatElapsed, isRunning, rowCommand } from "@/lib/terminal-command";
import { CommandIcon, useNow } from "./WorktreeStatus";
import {
  attachTerminal,
  closeTerminal,
  listTerminalsForWorktree,
  openTerminal,
  ptyResize,
  ptyWrite,
} from "@/ipc/client";
import type { PtyEvent, TerminalCommand, TerminalId, WorktreeId } from "@/ipc/types";
import { cn } from "@/lib/cn";
import {
  closeLeaf,
  firstLeaf,
  leaves,
  makeLeaf,
  setLeafMode,
  splitLeaf,
  type PaneLeaf,
  type PaneNode,
} from "./pane-tree";
import {
  EMPTY_LAYOUT,
  reconcileLayout,
  useTerminalLayoutStore,
  type TerminalTab,
} from "@/stores/terminal-layout";
import { fitAndPin, watchFit, whenSized } from "./xterm-fit";
import { registerTerminalLinks } from "./term-path-links";
import { attachTerminalSearch } from "./term-search";

export function TerminalPane() {
  const worktreeId = useUiStore((s) => s.selectedWorktreeId);
  if (!worktreeId) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-neutral-600">
        Select a worktree to open a terminal
      </div>
    );
  }
  return <TerminalTabs key={worktreeId} worktreeId={worktreeId} />;
}

function TerminalTabs({ worktreeId }: { worktreeId: WorktreeId }) {
  const layout = useTerminalLayoutStore(
    (s) => s.layouts[worktreeId] ?? EMPTY_LAYOUT,
  );
  const updateLayout = useTerminalLayoutStore((s) => s.updateLayout);
  const [initLoading, setInitLoading] = useState(true);
  /// LeafState pool lives in a module-level map keyed by worktreeId so
  /// the xterm Terminal + its host element survive `TerminalTabs`
  /// unmount/remount on worktree switch. If we tore them down at switch
  /// time, the next visit would create a fresh Terminal at 80×24 and
  /// then `fit.fit()` to the slot's real dims would trigger a
  /// `term.resize` → SIGWINCH → zsh redraw with PROMPT_SP (`%`
  /// artefacts). Keeping the term alive means same dims after remount,
  /// no SIGWINCH, no redraw.
  const leafStates = useMemo(() => getLeafStates(worktreeId), [worktreeId]);

  // Adopt running PTYs into the layout, seeding a first terminal when
  // there are none. At most one adopt per worktree is in flight: a
  // second run (StrictMode's double mount, or a quick switch away and
  // back) can race the freshly-seeded tab's openTerminal call —
  // listTerminalsForWorktree picks up the new PTY before the leaf has
  // flipped from `open` to `attach`, so reconcile appends a phantom
  // second tab pointing at the same session. The adopt writes to the
  // store, not component state, so it's applied even if the mount that
  // started it is gone; it must never be dropped on cleanup, or under
  // StrictMode the cancelled first run seeds nothing and the skipped
  // second run leaves the pane empty.
  useEffect(() => {
    let inFlight = adoptsInFlight.get(worktreeId);
    if (!inFlight) {
      inFlight = adopt(worktreeId, leafStates).finally(() =>
        adoptsInFlight.delete(worktreeId),
      );
      adoptsInFlight.set(worktreeId, inFlight);
    }
    let unmounted = false;
    void inFlight.then(() => {
      if (!unmounted) setInitLoading(false);
    });
    return () => {
      unmounted = true;
    };
  }, [worktreeId, leafStates]);

  const tabs = layout.tabs;
  const activeTabId = layout.activeTabId;

  function setActiveTabId(id: string | null) {
    updateLayout(worktreeId, (prev) => ({ ...prev, activeTabId: id }));
  }

  function addTab() {
    // Shared with the Cmd+T global shortcut — see terminal-layout store.
    useTerminalLayoutStore.getState().addTab(worktreeId);
  }

  async function closeTab(localId: string) {
    const tab = tabs.find((t) => t.localId === localId);
    if (tab) {
      for (const l of leaves(tab.tree)) {
        const state = leafStates.get(l.localId);
        if (state) {
          disposeLeafState(state);
          leafStates.delete(l.localId);
        } else if (l.mode.kind === "attach") {
          // Defensive: leaf was attach-mode in stored layout but no
          // local xterm state was ever created (visited the tab but
          // never rendered, or reconcile kept it alive after a worktree
          // switch). Kill the PTY directly.
          await closeTerminal(l.mode.terminalId).catch(() => {});
        }
      }
    }
    updateLayout(worktreeId, (prev) => {
      const tabs = prev.tabs.filter((t) => t.localId !== localId);
      const activeTabId =
        prev.activeTabId === localId
          ? tabs[tabs.length - 1]?.localId ?? null
          : prev.activeTabId;
      return { ...prev, tabs, activeTabId };
    });
  }

  function splitActive(direction: "horizontal" | "vertical") {
    updateLayout(worktreeId, (prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) => {
        if (tab.localId !== prev.activeTabId) return tab;
        const newLeaf = makeLeaf({ kind: "open" });
        return {
          ...tab,
          tree: splitLeaf(tab.tree, tab.activeLeafId, direction, newLeaf),
          activeLeafId: newLeaf.localId,
        };
      }),
    }));
  }

  async function closePane(tabId: string, leafId: string) {
    const state = leafStates.get(leafId);
    if (state) {
      disposeLeafState(state);
      leafStates.delete(leafId);
    } else {
      const tab = tabs.find((t) => t.localId === tabId);
      const leaf = tab
        ? leaves(tab.tree).find((l) => l.localId === leafId)
        : null;
      if (leaf && leaf.mode.kind === "attach") {
        await closeTerminal(leaf.mode.terminalId).catch(() => {});
      }
    }
    updateLayout(worktreeId, (prev) => {
      const tabs: typeof prev.tabs = [];
      let removedTab = false;
      for (const t of prev.tabs) {
        if (t.localId !== tabId) {
          tabs.push(t);
          continue;
        }
        const tree = closeLeaf(t.tree, leafId);
        if (tree === null) {
          removedTab = true;
          continue;
        }
        tabs.push({ ...t, tree, activeLeafId: firstLeaf(tree).localId });
      }
      const activeTabId =
        removedTab && prev.activeTabId === tabId
          ? tabs[tabs.length - 1]?.localId ?? null
          : prev.activeTabId;
      return { ...prev, tabs, activeTabId };
    });
  }

  function setActiveLeaf(tabId: string, leafId: string) {
    updateLayout(worktreeId, (prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.localId === tabId ? { ...tab, activeLeafId: leafId } : tab,
      ),
    }));
  }

  // When a freshly-opened leaf gets its server session id back, flip
  // its mode in the layout from `open` to `attach` so the next adopt
  // pass can hand it off without re-spawning.
  function onLeafSession(tabId: string, leafId: string, terminalId: TerminalId) {
    updateLayout(worktreeId, (prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.localId === tabId
          ? { ...tab, tree: setLeafMode(tab.tree, leafId, { kind: "attach", terminalId }) }
          : tab,
      ),
    }));
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950">
      <TabBar
        worktreeId={worktreeId}
        tabs={tabs}
        activeId={activeTabId}
        onSelect={setActiveTabId}
        onClose={(id) => void closeTab(id)}
        onNew={addTab}
        onSplitRight={() => splitActive("horizontal")}
        onSplitDown={() => splitActive("vertical")}
        canSplit={activeTabId !== null}
      />
      <div className="relative flex-1">
        {tabs.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-600">
            {initLoading
              ? "Checking for running terminals…"
              : "No terminals. Click + to open one."}
          </div>
        )}
        {tabs.map((tab) => {
          const tabVisible = tab.localId === activeTabId;
          return (
            <div
              key={tab.localId}
              className={cn(
                "absolute inset-0",
                !tabVisible && "pointer-events-none",
              )}
              style={{ visibility: tabVisible ? "visible" : "hidden" }}
            >
              <PaneRender
                node={tab.tree}
                worktreeId={worktreeId}
                tabVisible={tabVisible}
                activeLeafId={tab.activeLeafId}
                split={tab.tree.kind !== "leaf"}
                leafStates={leafStates}
                onActivate={(leafId) => setActiveLeaf(tab.localId, leafId)}
                onClose={(leafId) => void closePane(tab.localId, leafId)}
                onSession={(leafId, id) => onLeafSession(tab.localId, leafId, id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const adoptsInFlight = new Map<WorktreeId, Promise<void>>();

async function adopt(
  worktreeId: WorktreeId,
  leafStates: Map<string, LeafState>,
): Promise<void> {
  let running;
  try {
    running = await listTerminalsForWorktree(worktreeId);
  } catch {
    return;
  }
  useTerminalLayoutStore.getState().updateLayout(worktreeId, (prev) => {
    let next = reconcileLayout(prev, running);
    if (next.tabs.length === 0) {
      const counter = next.counter + 1;
      const leaf = makeLeaf({ kind: "open" });
      next = {
        tabs: [
          {
            localId: crypto.randomUUID(),
            label: `zsh ${counter}`,
            tree: leaf,
            activeLeafId: leaf.localId,
          },
        ],
        activeTabId: null,
        counter,
      };
      next.activeTabId = next.tabs[0].localId;
    }
    // Drop any pooled leaf states whose leaves were pruned by
    // reconcile (their PTY died while we were elsewhere). Without
    // this the pool would slowly accumulate dead xterm Terminals.
    const surviving = new Set<string>();
    for (const tab of next.tabs) {
      for (const l of leaves(tab.tree)) surviving.add(l.localId);
    }
    for (const [id, state] of leafStates) {
      if (!surviving.has(id)) {
        detachLeafState(state);
        leafStates.delete(id);
      }
    }
    return next;
  });
}

/// Recursive renderer for a pane tree. Splits become resizable
/// `<PanelGroup>`s; leaves render the actual terminal wrapper.
function PaneRender(props: {
  node: PaneNode;
  worktreeId: WorktreeId;
  tabVisible: boolean;
  activeLeafId: string;
  split: boolean;
  leafStates: Map<string, LeafState>;
  onActivate: (leafId: string) => void;
  onClose: (leafId: string) => void;
  onSession: (leafId: string, id: TerminalId) => void;
}): React.ReactNode {
  const { node } = props;
  if (node.kind === "leaf") {
    return <PaneLeafView leaf={node} {...props} />;
  }
  return (
    <PanelGroup
      direction={node.direction}
      autoSaveId={`treehouse-pane-${node.id}`}
      className="h-full w-full"
    >
      <Panel defaultSize={50} minSize={10}>
        <PaneRender {...props} node={node.a} />
      </Panel>
      <PanelResizeHandle
        className={cn(
          "bg-neutral-800 hover:bg-neutral-700",
          node.direction === "horizontal" ? "w-px" : "h-px",
        )}
      />
      <Panel defaultSize={50} minSize={10}>
        <PaneRender {...props} node={node.b} />
      </Panel>
    </PanelGroup>
  );
}

function PaneLeafView({
  leaf,
  worktreeId,
  tabVisible,
  activeLeafId,
  split,
  leafStates,
  onActivate,
  onClose,
  onSession,
}: {
  leaf: PaneLeaf;
  worktreeId: WorktreeId;
  tabVisible: boolean;
  activeLeafId: string;
  split: boolean;
  leafStates: Map<string, LeafState>;
  onActivate: (leafId: string) => void;
  onClose: (leafId: string) => void;
  onSession: (leafId: string, id: TerminalId) => void;
}) {
  const isActive = activeLeafId === leaf.localId;
  return (
    <div
      onMouseDown={() => onActivate(leaf.localId)}
      className={cn(
        "group relative h-full w-full",
        // Only meaningful when there's another pane to tell apart from.
        split && isActive && "ring-1 ring-inset ring-blue-400/20",
      )}
    >
      <TerminalLeafSlot
        leaf={leaf}
        worktreeId={worktreeId}
        visible={tabVisible}
        focused={tabVisible && isActive}
        leafStates={leafStates}
        onSession={(id) => onSession(leaf.localId, id)}
      />
      <div className="pointer-events-none absolute right-1 top-1 z-10 flex gap-0.5 opacity-0 transition group-hover:opacity-100">
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => onClose(leaf.localId)}
          title="Close pane"
          className="pointer-events-auto rounded border border-neutral-800 bg-neutral-900/90 px-1 py-0.5 text-[10px] text-neutral-400 hover:border-red-800 hover:text-red-300"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

const NO_COMMANDS: TerminalCommand[] = [];

function TabBar({
  worktreeId,
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onSplitRight,
  onSplitDown,
  canSplit,
}: {
  worktreeId: WorktreeId;
  tabs: TerminalTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  canSplit: boolean;
}) {
  // Tabs name the command running in them (shell integration), with a
  // running / passed / failed icon, the same way the sidebar rows do.
  const commands =
    useActivityStore((s) => s.byWorktree[worktreeId]?.commands) ?? NO_COMMANDS;
  const now = useNow(commands.some(isRunning));
  return (
    <div className={instanceStrip}>
      {tabs.map((tab) => {
        const ids = new Set(
          leaves(tab.tree).flatMap((l) => (l.mode.kind === "attach" ? [l.mode.terminalId] : [])),
        );
        const shown = rowCommand(
          commands.filter((c) => ids.has(c.terminalId)),
          now,
        )?.command;
        return (
          <div
            key={tab.localId}
            onClick={() => onSelect(tab.localId)}
            className={instanceTab(tab.localId === activeId)}
            title={shown?.command}
          >
            {shown ? (
              <CommandIcon command={shown} size={12} />
            ) : (
              <SquareTerminal size={12} className="shrink-0" />
            )}
            <span className="max-w-[16rem] truncate font-mono">
              {shown ? commandLabel(shown.command) || tab.label : tab.label}
            </span>
            {shown && isRunning(shown) && (
              <span className="shrink-0 font-mono text-neutral-500">
                {formatElapsed(now - shown.startedAt)}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.localId);
              }}
              className={instanceTabClose(tab.localId === activeId)}
              title="Close terminal"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
      <div className="ml-auto flex shrink-0 items-center gap-0.5 px-1.5">
        <button
          onClick={onSplitRight}
          disabled={!canSplit}
          title="Split active pane to the right"
          className={iconButton}
        >
          <Columns2 size={13} />
        </button>
        <button
          onClick={onSplitDown}
          disabled={!canSplit}
          title="Split active pane below"
          className={iconButton}
        >
          <Rows2 size={13} />
        </button>
        <button
          onClick={onNew}
          title="New terminal"
          className={iconButton}
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

/// Per-leaf state lives in a Map per worktreeId at module scope so it
/// survives both PaneLeafView remounts (split / sibling-close) and
/// TerminalTabs remounts on worktree switch. Without this, splitting
/// or revisiting a worktree tears down xterms and reattaches PTYs —
/// zsh redraws via PROMPT_SP and the user sees `%` artifacts.
const leafStatesByWorktree = new Map<WorktreeId, Map<string, LeafState>>();

function getLeafStates(worktreeId: WorktreeId): Map<string, LeafState> {
  let m = leafStatesByWorktree.get(worktreeId);
  if (!m) {
    m = new Map();
    leafStatesByWorktree.set(worktreeId, m);
  }
  return m;
}

export type LeafState = {
  host: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  sessionId: TerminalId | null;
  fitWatch: { disconnect: () => void } | null;
  /// xterm link provider disposable. Released in `disposeLeafState`
  /// alongside the terminal so we don't accumulate dead listeners.
  pathLinks: { dispose: () => void } | null;
  /// Sticky once disposeLeafState runs. Guards the async open/attach
  /// path against doing anything (and against orphaning a PTY) if the
  /// leaf was killed before the IPC resolved.
  killed: boolean;
};

export function createLeafState(
  worktreeId: WorktreeId,
  leaf: PaneLeaf,
  onSession: (id: TerminalId) => void,
): LeafState {
  const host = document.createElement("div");
  host.style.position = "absolute";
  // 8px breathing room around the terminal — applied as `inset` rather
  // than `padding` because xterm-addon-fit reads padding from
  // `terminal.element` (no padding), not from its parent (this host).
  // With `padding: 8px; box-sizing: border-box`, fit() saw the full
  // host height and over-counted rows by one — the bottom line ended
  // up clipped under the padding-bottom.
  host.style.inset = "8px";
  // Clip rather than scroll if xterm's grid momentarily outsizes the
  // host (rounding, a fit racing a resize) — xterm's own viewport is
  // the only thing that should ever scroll.
  host.style.overflow = "hidden";

  const term = new Terminal({
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    theme: {
      background: "#0F1114",
      foreground: "#BBBEBF",
      cursor: "#BBBEBF",
    },
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // Cmd+click on file paths opens them in the editor; on URLs, in
  // the system browser.
  const termLinks = registerTerminalLinks(term, worktreeId);
  // Cmd+F overlay search.
  const search = attachTerminalSearch(term, host);
  // Chain into the term's custom key handler so Cmd+F opens the
  // search bar before xterm consumes the keystroke.
  term.attachCustomKeyEventHandler((ev) => {
    if (search.tryHandleKey(ev)) return false;
    return true;
  });
  const linksDisposable = {
    dispose() {
      termLinks.dispose();
      search.dispose();
    },
  };

  const state: LeafState = {
    host,
    term,
    fit,
    sessionId: null,
    fitWatch: null,
    pathLinks: linksDisposable,
    killed: false,
  };

  const encoder = new TextEncoder();
  const onEvent = (ev: PtyEvent) => {
    if (state.killed) return;
    if (ev.kind === "data") {
      term.write(new Uint8Array(ev.bytes));
    } else if (ev.kind === "exit") {
      term.write(
        `\r\n\x1b[38;2;140;140;140m[process exited${
          ev.code !== null ? ` — code ${ev.code}` : ""
        }]\x1b[0m\r\n`,
      );
    }
  };

  (async () => {
    try {
      // The caller mounts `host` into its slot synchronously after we
      // return. A new shell waits until that slot is actually laid out
      // and visible (see whenSized) so it spawns at the fitted size;
      // an attach just yields once — the shell already has its size.
      if (leaf.mode.kind === "open") await whenSized(host);
      else await Promise.resolve();
      if (state.killed) return;
      if (host.isConnected) fitAndPin(fit, term);
      let session;
      if (leaf.mode.kind === "open") {
        session = await openTerminal(worktreeId, term.cols, term.rows, onEvent);
        // Killed before the PTY came back — kill the orphan so it
        // doesn't reappear as a phantom tab on the next worktree visit.
        if (state.killed) {
          await closeTerminal(session.id).catch(() => {});
          return;
        }
      } else {
        session = await attachTerminal(leaf.mode.terminalId, onEvent);
        if (state.killed) return;
      }
      state.sessionId = session.id;
      onSession(session.id);

      // If the leaf was opened with a setup script attached, push it
      // into the PTY stdin once the shell has spawned so the commands
      // run on first paint and the user lands at a clean prompt
      // afterward. Used by the worktree post-create hook.
      if (
        leaf.mode.kind === "open" &&
        leaf.mode.initInput &&
        !state.killed
      ) {
        ptyWrite(state.sessionId, encoder.encode(leaf.mode.initInput)).catch(
          () => {},
        );
      }

      term.onData((data) => {
        if (state.sessionId && !state.killed) {
          ptyWrite(state.sessionId, encoder.encode(data)).catch(() => {});
        }
      });
      term.onResize(({ cols, rows }) => {
        if (state.sessionId && !state.killed) {
          ptyResize(state.sessionId, cols, rows).catch(() => {});
        }
      });
      // A fit() during open/attach fired onResize before the listener
      // above existed — push the current size so the PTY isn't stale.
      if (host.isConnected) {
        fitAndPin(fit, term);
        ptyResize(session.id, term.cols, term.rows).catch(() => {});
      }
      // Refits on host resize, late font load, and DPR change; skips
      // while the host is parked off-DOM (see watchFit).
      state.fitWatch = watchFit(host, fit, term);
    } catch (e) {
      term.write(`\r\nerror: failed to open terminal — ${e}\r\n`);
    }
  })();

  return state;
}

/// Tear down a leaf's xterm AND kill its PTY. Safe to call while the
/// async open/attach is still in flight — the `killed` flag short-
/// circuits and orphan-kills inside that path.
export function disposeLeafState(state: LeafState) {
  state.killed = true;
  state.fitWatch?.disconnect();
  state.pathLinks?.dispose();
  state.term.dispose();
  if (state.sessionId) {
    closeTerminal(state.sessionId).catch(() => {});
  }
}

/// Tear down xterm but keep the PTY alive on the Rust side — used on
/// worktree switch so the user can come back and reattach.
function detachLeafState(state: LeafState) {
  state.killed = true;
  state.fitWatch?.disconnect();
  state.pathLinks?.dispose();
  state.term.dispose();
}

function TerminalLeafSlot({
  leaf,
  worktreeId,
  visible,
  focused,
  leafStates,
  onSession,
}: {
  leaf: PaneLeaf;
  worktreeId: WorktreeId;
  visible: boolean;
  focused: boolean;
  leafStates: Map<string, LeafState>;
  onSession: (id: TerminalId) => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);

  // Attach this leaf's persistent host element into our slot. On unmount
  // (split / sibling-close that destroys this slot), detach but DON'T
  // dispose — the state stays in the map keyed by leaf.localId and the
  // next mount will reattach it intact.
  //
  // Deps are scoped to leaf.localId on purpose: the effect must run
  // exactly once per slot lifetime (per leaf identity), not on every
  // parent re-render. Including the leaf object or the freshly-bound
  // `onSession` function in deps would re-run the effect on every
  // ancestor render, briefly detaching the xterm host from the DOM
  // during cleanup → reattach — that's what was producing the cross-
  // pane breakage when multiple splits existed.
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    let state = leafStates.get(leaf.localId);
    if (!state) {
      state = createLeafState(worktreeId, leaf, onSession);
      leafStates.set(leaf.localId, state);
    }
    slot.appendChild(state.host);
    try {
      fitAndPin(state.fit, state.term);
    } catch {}
    return () => {
      if (state.host.parentNode === slot) {
        slot.removeChild(state.host);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaf.localId]);

  useEffect(() => {
    if (!visible) return;
    const state = leafStates.get(leaf.localId);
    if (!state) return;
    try {
      fitAndPin(state.fit, state.term);
    } catch {}
  }, [visible, leaf.localId, leafStates]);

  useEffect(() => {
    if (!focused) return;
    leafStates.get(leaf.localId)?.term.focus();
  }, [focused, leaf.localId, leafStates]);

  return <div ref={slotRef} className="relative h-full w-full overflow-hidden" />;
}
