import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import {
  agentResize,
  agentWrite,
  attachAgent,
  killAgent,
  launchAgent,
  listAgentsForWorktree,
} from "@/ipc/client";
import type {
  AgentBackendKind,
  AgentEvent,
  AgentSessionId,
  WorktreeId,
} from "@/ipc/types";
import { cn } from "@/lib/cn";
import { fitAndPin } from "./xterm-fit";

const BACKENDS: { label: string; value: AgentBackendKind }[] = [
  { label: "Claude Code", value: "claudeCode" },
  { label: "Codex", value: "codex" },
  { label: "Kiro", value: "kiro" },
];

const BACKEND_LABELS: Record<AgentBackendKind, string> = {
  claudeCode: "Claude",
  codex: "Codex",
  kiro: "Kiro",
};

export function AgentPane() {
  const worktreeId = useUiStore((s) => s.selectedWorktreeId);
  const worktree = useWorktreesStore((s) =>
    s.worktrees.find((w) => w.id === worktreeId),
  );

  if (!worktreeId || !worktree) {
    return (
      <div className="flex h-full items-center justify-center border-l border-neutral-800 text-xs text-neutral-600">
        Select a worktree to launch an agent
      </div>
    );
  }
  // Main-clone case: Workspace.tsx omits this pane entirely.
  return <AgentTabs key={worktreeId} worktreeId={worktreeId} />;
}

type Tab = {
  localId: string;
  mode: Mode;
  backend: AgentBackendKind;
  label: string;
};

type Mode =
  | { kind: "launch"; backend: AgentBackendKind }
  | { kind: "attach"; agentId: AgentSessionId };

function AgentTabs({ worktreeId }: { worktreeId: WorktreeId }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const defaultBackend = useSettingsStore((s) => s.settings.defaultAgentBackend);
  const [backend, setBackend] = useState<AgentBackendKind>(defaultBackend);
  // If settings load after this component mounted, and the user hasn't
  // touched the dropdown yet, pick up the persisted default. Guarded by a
  // ref so we only do this once per mount — subsequent Settings edits
  // shouldn't stomp an active in-flight selection.
  const pickedUpDefault = useRef(false);
  useEffect(() => {
    if (pickedUpDefault.current) return;
    pickedUpDefault.current = true;
    setBackend(defaultBackend);
  }, [defaultBackend]);
  const [initLoading, setInitLoading] = useState(true);
  const sessionIds = useRef<Map<string, AgentSessionId>>(new Map());
  const setActiveAgent = useUiStore((s) => s.setActiveAgent);

  // Mirror the active tab's session id into the UI store so other parts of
  // the app (notably the inline-comment send button) know which agent
  // receives messages for this worktree.
  useEffect(() => {
    const id = activeId ? sessionIds.current.get(activeId) ?? null : null;
    setActiveAgent(worktreeId, id);
  }, [activeId, worktreeId, setActiveAgent]);
  const counters = useRef<Record<AgentBackendKind, number>>({
    claudeCode: 0,
    codex: 0,
    kiro: 0,
  });

  // On worktree switch: discover already-running agents and adopt them as
  // attach-mode tabs so the user doesn't lose live sessions.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await listAgentsForWorktree(worktreeId);
        if (cancelled) return;
        const adopted: Tab[] = existing.map((s) => {
          counters.current[s.backend] =
            (counters.current[s.backend] ?? 0) + 1;
          const localId = crypto.randomUUID();
          sessionIds.current.set(localId, s.id);
          return {
            localId,
            mode: { kind: "attach", agentId: s.id },
            backend: s.backend,
            label: `${BACKEND_LABELS[s.backend]} ${counters.current[s.backend]}`,
          };
        });
        setTabs(adopted);
        setActiveId(adopted[adopted.length - 1]?.localId ?? null);
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

  function onLaunch() {
    counters.current[backend] = (counters.current[backend] ?? 0) + 1;
    const next: Tab = {
      localId: crypto.randomUUID(),
      mode: { kind: "launch", backend },
      backend,
      label: `${BACKEND_LABELS[backend]} ${counters.current[backend]}`,
    };
    setTabs((prev) => [...prev, next]);
    setActiveId(next.localId);
  }

  async function closeTab(localId: string) {
    const agentId = sessionIds.current.get(localId);
    if (agentId) {
      await killAgent(agentId).catch(() => {});
    }
    sessionIds.current.delete(localId);
    setTabs((prev) => {
      const next = prev.filter((t) => t.localId !== localId);
      setActiveId((cur) => {
        if (cur !== localId) return cur;
        return next.length > 0 ? next[next.length - 1].localId : null;
      });
      return next;
    });
  }

  const hasTabs = tabs.length > 0;

  return (
    <div className="flex h-full flex-col border-l border-neutral-800 bg-neutral-950">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-800 px-1 py-0.5">
        {tabs.map((tab) => (
          <div
            key={tab.localId}
            onClick={() => setActiveId(tab.localId)}
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
                closeTab(tab.localId);
              }}
              className="opacity-0 transition group-hover:opacity-100 text-neutral-500 hover:text-red-400"
              title="Kill agent"
            >
              ✕
            </button>
          </div>
        ))}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <select
            value={backend}
            onChange={(e) => setBackend(e.target.value as AgentBackendKind)}
            className="rounded border border-neutral-800 bg-neutral-900 px-1 py-0.5 text-[11px] focus:outline-none"
          >
            {BACKENDS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
          <button
            onClick={onLaunch}
            title="Launch new agent"
            className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-blue-500"
          >
            + Launch
          </button>
        </div>
      </div>

      <div className="relative flex-1">
        {!hasTabs && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-600">
            {initLoading
              ? "Checking for running agents…"
              : "Pick a backend and click + Launch"}
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
            <AgentInstance
              worktreeId={worktreeId}
              mode={tab.mode}
              visible={tab.localId === activeId}
              onSession={(id) => {
                sessionIds.current.set(tab.localId, id);
                // The mirror-to-store effect above only re-runs when
                // `activeId` changes, not when the session id arrives —
                // push it directly so other parts of the app (send-queue,
                // per-comment Send) see the agent immediately.
                if (tab.localId === activeId) {
                  setActiveAgent(worktreeId, id);
                }
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentInstance({
  worktreeId,
  mode,
  visible,
  onSession,
}: {
  worktreeId: WorktreeId;
  mode: Mode;
  visible: boolean;
  onSession: (id: AgentSessionId) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const agentIdRef = useRef<AgentSessionId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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
      scrollback: 20_000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const encoder = new TextEncoder();
    const onEvent = (ev: AgentEvent) => {
      if (ev.kind === "data") {
        term.write(new Uint8Array(ev.bytes));
      } else if (ev.kind === "status") {
        if (ev.status.kind === "exited" || ev.status.kind === "crashed") {
          const suffix =
            ev.status.kind === "exited"
              ? ev.status.code !== null
                ? ` (code ${ev.status.code})`
                : ""
              : `: ${ev.status.message}`;
          term.write(
            `\r\n\x1b[38;2;140;140;140m[agent ${ev.status.kind}${suffix}]\x1b[0m\r\n`,
          );
        }
      }
    };

    let ro: ResizeObserver | null = null;
    let disposed = false;

    (async () => {
      try {
        let id: AgentSessionId;
        if (mode.kind === "launch") {
          const s = await launchAgent(
            worktreeId,
            mode.backend,
            term.cols,
            term.rows,
            onEvent,
          );
          id = s.id;
        } else {
          const s = await attachAgent(mode.agentId, onEvent);
          id = s.id;
        }
        if (disposed) return;
        agentIdRef.current = id;
        onSession(id);

        term.onData((data) => {
          if (agentIdRef.current) {
            agentWrite(agentIdRef.current, encoder.encode(data)).catch(() => {});
          }
        });
        term.onResize(({ cols, rows }) => {
          if (agentIdRef.current) {
            agentResize(agentIdRef.current, cols, rows).catch(() => {});
          }
        });
        ro = new ResizeObserver(() => {
          fitAndPin(fit, term);
        });
        ro.observe(host);
      } catch (e: unknown) {
        const msg =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
        setError(msg);
      }
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      agentIdRef.current = null;
      // NOTE: we do NOT killAgent on unmount. Worktree switches should keep
      // agents running; only explicit tab-close kills. The parent handles
      // that via closeTab → killAgent before removing the tab.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId]);

  useEffect(() => {
    if (!visible) return;
    const fit = fitRef.current;
    const term = termRef.current;
    if (fit && term) fitAndPin(fit, term);
    if (term) term.focus();
  }, [visible]);

  return (
    <div className="flex h-full w-full flex-col">
      {error && (
        <div className="m-3 shrink-0 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      {/* Wrap xterm's host in a `relative flex-1` box so the host itself
          can stay `absolute inset-0`. Xterm's fit()'s internal DOM resizes
          have to NOT influence this container, or its ResizeObserver loops
          infinitely — `absolute` decouples child size from parent layout. */}
      <div className="relative flex-1">
        <div ref={hostRef} className="absolute inset-0 p-2" />
      </div>
    </div>
  );
}
