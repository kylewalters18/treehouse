import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

import { useUiStore } from "@/stores/ui";
import {
  attachTerminal,
  closeTerminal,
  listTerminalsForWorktree,
  openTerminal,
  ptyResize,
  ptyWrite,
} from "@/ipc/client";
import type { PtyEvent, TerminalId, WorktreeId } from "@/ipc/types";
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
import { fitAndPin } from "./xterm-fit";
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
  // Sentinel for the adopt effect — StrictMode double-mounts in dev,
  // and a second adopt run can race the freshly-seeded tab's openTerminal
  // call: listTerminalsForWorktree picks up the new PTY before the leaf
  // has flipped from `open` to `attach` mode in the store, so reconcile
  // treats it as unknown and appends a phantom second tab pointing at
  // the same session. Skipping the second run is safer than chasing the
  // race with extra in-flight tracking.
  const adoptedFor = useRef<WorktreeId | null>(null);
  /// LeafState pool lives in a module-level map keyed by worktreeId so
  /// the xterm Terminal + its host element survive `TerminalTabs`
  /// unmount/remount on worktree switch. If we tore them down at switch
  /// time, the next visit would create a fresh Terminal at 80×24 and
  /// then `fit.fit()` to the slot's real dims would trigger a
  /// `term.resize` → SIGWINCH → zsh redraw with PROMPT_SP (`%`
  /// artefacts). Keeping the term alive means same dims after remount,
  /// no SIGWINCH, no redraw.
  const leafStates = useMemo(() => getLeafStates(worktreeId), [worktreeId]);

  useEffect(() => {
    if (adoptedFor.current === worktreeId) {
      // StrictMode's second mount: mount 1 already adopted (or is in
      // flight). Mount 1's finally skipped its setInitLoading because
      // its closure was cancelled by cleanup, so clear it here instead
      // — otherwise the pane sits on "Checking…" forever.
      setInitLoading(false);
      return;
    }
    adoptedFor.current = worktreeId;
    let cancelled = false;
    (async () => {
      try {
        const running = await listTerminalsForWorktree(worktreeId);
        if (cancelled) return;
        updateLayout(worktreeId, (prev) => {
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
      } catch {
        // ignore
      } finally {
        if (!cancelled) setInitLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [worktreeId, updateLayout]);

  const tabs = layout.tabs;
  const activeTabId = layout.activeTabId;

  function setActiveTabId(id: string | null) {
    updateLayout(worktreeId, (prev) => ({ ...prev, activeTabId: id }));
  }

  function addTab() {
    updateLayout(worktreeId, (prev) => {
      const counter = prev.counter + 1;
      const leaf = makeLeaf({ kind: "open" });
      const next = {
        localId: crypto.randomUUID(),
        label: `zsh ${counter}`,
        tree: leaf,
        activeLeafId: leaf.localId,
      };
      return {
        tabs: [...prev.tabs, next],
        activeTabId: next.localId,
        counter,
      };
    });
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

/// Recursive renderer for a pane tree. Splits become resizable
/// `<PanelGroup>`s; leaves render the actual terminal wrapper.
function PaneRender(props: {
  node: PaneNode;
  worktreeId: WorktreeId;
  tabVisible: boolean;
  activeLeafId: string;
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
  leafStates,
  onActivate,
  onClose,
  onSession,
}: {
  leaf: PaneLeaf;
  worktreeId: WorktreeId;
  tabVisible: boolean;
  activeLeafId: string;
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
        isActive && "ring-1 ring-inset ring-blue-500/40",
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

function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onSplitRight,
  onSplitDown,
  canSplit,
}: {
  tabs: TerminalTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  canSplit: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-neutral-800 px-1 py-0.5">
      {tabs.map((tab) => (
        <div
          key={tab.localId}
          onClick={() => onSelect(tab.localId)}
          className={cn(
            "group flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-[11px]",
            tab.localId === activeId
              ? "bg-neutral-800 text-neutral-100"
              : "text-neutral-400 hover:bg-neutral-900",
          )}
        >
          <span className="font-mono">{tab.label}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.localId);
            }}
            className="opacity-0 transition group-hover:opacity-100 text-neutral-500 hover:text-red-400"
            title="Close terminal"
          >
            ✕
          </button>
        </div>
      ))}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          onClick={onSplitRight}
          disabled={!canSplit}
          title="Split active pane to the right"
          className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ⇥
        </button>
        <button
          onClick={onSplitDown}
          disabled={!canSplit}
          title="Split active pane below"
          className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ⤓
        </button>
        <button
          onClick={onNew}
          title="New terminal"
          className="ml-0.5 rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
        >
          +
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
  resizeObserver: ResizeObserver | null;
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
  host.style.inset = "0";
  host.style.padding = "8px";
  host.style.boxSizing = "border-box";

  const term = new Terminal({
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    theme: {
      background: "#121314",
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
    resizeObserver: null,
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
      state.resizeObserver = new ResizeObserver(() => {
        fitAndPin(fit, term);
      });
      state.resizeObserver.observe(host);
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
  state.resizeObserver?.disconnect();
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
  state.resizeObserver?.disconnect();
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
      state.fit.fit();
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

  return <div ref={slotRef} className="relative h-full w-full" />;
}
