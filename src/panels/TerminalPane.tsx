import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";
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

type Mode =
  | { kind: "open" }
  | { kind: "attach"; terminalId: TerminalId };

type Tab = {
  localId: string;
  label: string;
  mode: Mode;
};

function TerminalTabs({ worktreeId }: { worktreeId: WorktreeId }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [initLoading, setInitLoading] = useState(true);
  const counter = useRef(0);
  const terminalIds = useRef<Map<string, TerminalId>>(new Map());

  // On worktree switch: adopt any existing terminals as attach-mode tabs so
  // navigating back doesn't kill or lose them. If there are none, seed a
  // fresh one so the pane isn't empty on first visit.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await listTerminalsForWorktree(worktreeId);
        if (cancelled) return;
        if (existing.length > 0) {
          const adopted: Tab[] = existing.map((s) => {
            counter.current += 1;
            const localId = crypto.randomUUID();
            terminalIds.current.set(localId, s.id);
            return {
              localId,
              label: `zsh ${counter.current}`,
              mode: { kind: "attach", terminalId: s.id },
            };
          });
          setTabs(adopted);
          setActiveId(adopted[adopted.length - 1].localId);
        } else {
          counter.current = 1;
          const fresh: Tab = {
            localId: crypto.randomUUID(),
            label: "zsh 1",
            mode: { kind: "open" },
          };
          setTabs([fresh]);
          setActiveId(fresh.localId);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setInitLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [worktreeId]);

  function addTab() {
    counter.current += 1;
    const next: Tab = {
      localId: crypto.randomUUID(),
      label: `zsh ${counter.current}`,
      mode: { kind: "open" },
    };
    setTabs((prev) => [...prev, next]);
    setActiveId(next.localId);
  }

  async function closeTab(localId: string) {
    const tid = terminalIds.current.get(localId);
    if (tid) {
      await closeTerminal(tid).catch(() => {});
    }
    terminalIds.current.delete(localId);
    setTabs((prev) => {
      const next = prev.filter((t) => t.localId !== localId);
      setActiveId((cur) => {
        if (cur !== localId) return cur;
        return next.length > 0 ? next[next.length - 1].localId : null;
      });
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950">
      <TabBar
        tabs={tabs}
        activeId={activeId}
        onSelect={setActiveId}
        onClose={(id) => void closeTab(id)}
        onNew={addTab}
      />
      <div className="relative flex-1">
        {tabs.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-600">
            {initLoading
              ? "Checking for running terminals…"
              : "No terminals. Click + to open one."}
          </div>
        )}
        {tabs.map((tab) => (
          <div
            key={tab.localId}
            className={cn(
              "absolute inset-0",
              tab.localId !== activeId && "pointer-events-none",
            )}
            style={{
              visibility: tab.localId === activeId ? "visible" : "hidden",
            }}
          >
            <TerminalInstance
              worktreeId={worktreeId}
              mode={tab.mode}
              visible={tab.localId === activeId}
              onSession={(id) => {
                terminalIds.current.set(tab.localId, id);
              }}
            />
          </div>
        ))}
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
}: {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
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
      <button
        onClick={onNew}
        title="New terminal"
        className="ml-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
      >
        +
      </button>
    </div>
  );
}

function TerminalInstance({
  worktreeId,
  mode,
  visible,
  onSession,
}: {
  worktreeId: WorktreeId;
  mode: Mode;
  visible: boolean;
  onSession: (id: TerminalId) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<TerminalId | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    const encoder = new TextEncoder();

    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
      },
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    termRef.current = term;
    fitRef.current = fit;

    term.open(host);
    fit.fit();

    const onEvent = (ev: PtyEvent) => {
      if (disposed) return;
      if (ev.kind === "data") {
        term.write(new Uint8Array(ev.bytes));
      } else if (ev.kind === "exit") {
        term.write(
          `\r\n\x1b[38;2;115;115;115m[process exited${
            ev.code !== null ? ` — code ${ev.code}` : ""
          }]\x1b[0m\r\n`,
        );
      }
    };

    (async () => {
      try {
        const session =
          mode.kind === "open"
            ? await openTerminal(worktreeId, term.cols, term.rows, onEvent)
            : await attachTerminal(mode.terminalId, onEvent);
        if (disposed) return;
        idRef.current = session.id;
        onSession(session.id);

        term.onData((data) => {
          if (idRef.current) {
            ptyWrite(idRef.current, encoder.encode(data)).catch(() => {});
          }
        });
        term.onResize(({ cols, rows }) => {
          if (idRef.current) {
            ptyResize(idRef.current, cols, rows).catch(() => {});
          }
        });
        resizeObserver = new ResizeObserver(() => {
          try {
            fit.fit();
          } catch {}
        });
        resizeObserver.observe(host);
      } catch (e) {
        term.write(`\r\nerror: failed to open terminal — ${e}\r\n`);
      }
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      idRef.current = null;
      // NOTE: we do NOT close the terminal on unmount. Worktree switches
      // should keep shells running; only explicit tab-close kills, via
      // closeTab → closeTerminal in the parent.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId]);

  // When this tab becomes active, re-fit to the (possibly changed) pane size
  // and refocus so typing flows in right away.
  useEffect(() => {
    if (!visible) return;
    const fit = fitRef.current;
    const term = termRef.current;
    if (fit) {
      try {
        fit.fit();
      } catch {}
    }
    if (term) {
      term.focus();
    }
  }, [visible]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="absolute inset-0 p-2" />
    </div>
  );
}
