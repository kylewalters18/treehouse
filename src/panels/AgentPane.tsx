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
  listBackendAgents,
} from "@/ipc/client";
import type {
  AgentBackendKind,
  AgentEvent,
  AgentSessionId,
  BackendAgent,
  WorktreeId,
} from "@/ipc/types";
import { cn } from "@/lib/cn";
import { fitAndPin } from "./xterm-fit";
import { registerTerminalLinks } from "./term-path-links";
import { attachTerminalSearch } from "./term-search";

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
  | { kind: "launch"; backend: AgentBackendKind; argv?: string[] }
  | { kind: "attach"; agentId: AgentSessionId };

/// Build an argv that pre-selects a sub-agent on the backend's CLI.
/// `null` agentName = use the backend default (no `--agent` flag).
function argvForAgent(
  backend: AgentBackendKind,
  agentName: string | null,
): string[] | undefined {
  if (!agentName) return undefined;
  switch (backend) {
    case "claudeCode":
      return ["claude", "--agent", agentName];
    case "kiro":
      // kiro-cli's default subcommand is `chat`; --agent only attaches there.
      return ["kiro-cli", "chat", "--agent", agentName];
    case "codex":
      return undefined;
  }
}

function backendSupportsAgents(backend: AgentBackendKind): boolean {
  return backend === "claudeCode" || backend === "kiro";
}

/// Pull the sub-agent name back out of an argv so adopted sessions get
/// the same `Claude 1 (foo)` label as freshly-launched ones, instead of
/// just `Claude 1`. Returns the bracketed suffix or "" if no `--agent`.
function argvAgentSuffix(argv: string[]): string {
  const i = argv.indexOf("--agent");
  if (i < 0 || i + 1 >= argv.length) return "";
  return ` (${argv[i + 1]})`;
}

function AgentTabs({ worktreeId }: { worktreeId: WorktreeId }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const defaultBackend = useSettingsStore((s) => s.settings.defaultAgentBackend);
  const [backend, setBackend] = useState<AgentBackendKind>(defaultBackend);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [agentsByBackend, setAgentsByBackend] = useState<
    Partial<Record<AgentBackendKind, BackendAgent[]>>
  >({});
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
  const setAgentLabel = useUiStore((s) => s.setAgentLabel);
  const clearAgentLabel = useUiStore((s) => s.clearAgentLabel);
  const setAgentTabOrder = useUiStore((s) => s.setAgentTabOrder);
  // Capture the persisted state at first render — refs ensure later
  // effects (in particular the mirror-active-agent effect, which writes
  // `null` to the store on initial mount) can't clobber the values
  // before the adoption effect reads them. `useRef`'s initializer is
  // evaluated each render but only the first one is committed, so this
  // pulls a snapshot once per worktree-mount.
  const initialPersisted = useRef<{
    active: AgentSessionId | null;
    order: AgentSessionId[];
  }>({
    active:
      useUiStore.getState().activeAgentByWorktree[worktreeId] ?? null,
    order: useUiStore.getState().agentTabOrderByWorktree[worktreeId] ?? [],
  });
  // Drag-and-drop state. `dragLocalId` is the tab being held; `dragOverLocalId`
  // is the tab the cursor currently hovers, used to paint the drop indicator.
  // We ALSO mirror the dragged id into a ref so synchronous handlers
  // (`onDrop`) can read it without depending on React state having
  // committed since `onDragStart`.
  const [dragLocalId, setDragLocalId] = useState<string | null>(null);
  const [dragOverLocalId, setDragOverLocalId] = useState<string | null>(null);
  const dragLocalIdRef = useRef<string | null>(null);
  // Re-publishing the tab order to the store before adoption finishes
  // would clobber the user's saved order with `[]`. Gate writes on this
  // flag, set true once the adoption useEffect has committed its result.
  const adoptionDone = useRef(false);
  // Mirror `tabs` into a ref so callbacks (notably `onSession`, which
  // fires asynchronously from `launchAgent`) can read the current
  // array without grabbing a stale closure. Refs are mutated during
  // render, which is fine — we're only writing, not subscribing.
  const tabsRef = useRef<Tab[]>([]);

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
  // attach-mode tabs so the user doesn't lose live sessions. Tabs are
  // sorted to the user's last-set order (per-worktree, persisted in the
  // UI store), and the active tab is restored from the stored
  // active-agent for this worktree — both fall back gracefully when the
  // stored state is empty or stale.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Read the persisted state from `initialPersisted` — captured
        // at first render, before any other effect could overwrite it.
        const storedOrder = initialPersisted.current.order;
        const storedActive = initialPersisted.current.active;

        const existing = await listAgentsForWorktree(worktreeId);
        if (cancelled) return;
        // Phase 1: assign labels in `started_at` order so an agent's
        // number reflects its identity, not its current display
        // position. Without this split, dragging "Claude 3" to the
        // front and bouncing through another worktree would relabel
        // the moved tab to "Claude 1" — labels must follow the agent.
        const labelBySession = new Map<string, string>();
        for (const s of existing) {
          counters.current[s.backend] =
            (counters.current[s.backend] ?? 0) + 1;
          const label = `${BACKEND_LABELS[s.backend]} ${counters.current[s.backend]}${argvAgentSuffix(s.argv)}`;
          labelBySession.set(s.id, label);
          setAgentLabel(s.id, label);
        }
        // Phase 2: stable sort to user-preferred display order;
        // sessions absent from storedOrder land at the end in their
        // original `started_at` order.
        const orderIndex = new Map(storedOrder.map((id, i) => [id, i]));
        const sorted = [...existing].sort((a, b) => {
          const ia = orderIndex.has(a.id)
            ? (orderIndex.get(a.id) as number)
            : Number.MAX_SAFE_INTEGER;
          const ib = orderIndex.has(b.id)
            ? (orderIndex.get(b.id) as number)
            : Number.MAX_SAFE_INTEGER;
          return ia - ib;
        });
        const adopted: Tab[] = sorted.map((s) => {
          const localId = crypto.randomUUID();
          sessionIds.current.set(localId, s.id);
          return {
            localId,
            mode: { kind: "attach", agentId: s.id },
            backend: s.backend,
            label: labelBySession.get(s.id) as string,
          };
        });
        setTabs(adopted);
        // Prefer the previously-active session if it still exists;
        // otherwise pick the last tab so the user lands somewhere.
        const matchActive =
          storedActive !== null
            ? adopted.find((t) => sessionIds.current.get(t.localId) === storedActive)
            : null;
        setActiveId(
          matchActive?.localId ?? adopted[adopted.length - 1]?.localId ?? null,
        );
        adoptionDone.current = true;
      } catch {
        adoptionDone.current = true;
      } finally {
        if (!cancelled) setInitLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [worktreeId]);

  // Lazily fetch the agent list for the currently-selected backend.
  // CLI shell-out costs ~100ms; cache per-backend for the lifetime of the
  // pane so toggling the backend dropdown back and forth is instant.
  useEffect(() => {
    if (!backendSupportsAgents(backend)) return;
    if (agentsByBackend[backend] !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await listBackendAgents(backend, worktreeId);
        if (cancelled) return;
        setAgentsByBackend((prev) => ({ ...prev, [backend]: list }));
      } catch {
        if (cancelled) return;
        setAgentsByBackend((prev) => ({ ...prev, [backend]: [] }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backend, worktreeId, agentsByBackend]);

  // Dropping into a backend that doesn't support agents (Codex) — clear
  // any stale selection so we don't pass a name the new backend can't use.
  useEffect(() => {
    if (!backendSupportsAgents(backend)) setAgentName(null);
  }, [backend]);

  // Mirror tabs into the ref every render. This is a ref write, not a
  // setState — safe to do during render.
  tabsRef.current = tabs;

  // Push the current tabs' session IDs (in display order) to the UI
  // store so a worktree switch + return restores the same order. Tabs
  // whose session ID hasn't been published yet (just-launched, awaiting
  // `onSession`) are filtered out — they'll get appended on the next
  // sync once their ID arrives. Call this from effects or from event
  // handlers — never from inside a `setTabs` updater (React invokes
  // updaters during render, and triggering a Zustand setter from there
  // produces "Cannot update a component while rendering" errors).
  function syncTabOrder() {
    if (!adoptionDone.current) return;
    const ids: AgentSessionId[] = [];
    for (const t of tabsRef.current) {
      const id = sessionIds.current.get(t.localId);
      if (id) ids.push(id);
    }
    setAgentTabOrder(worktreeId, ids);
  }

  // Re-sync whenever the rendered tab order changes (drop-reorder, new
  // launch, close). Runs after commit, so calling the Zustand setter
  // here is safe.
  useEffect(() => {
    syncTabOrder();
    // syncTabOrder is intentionally not in deps — it captures stable
    // store setter and refs, and re-creating it each render would
    // trigger this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  function onLaunch() {
    counters.current[backend] = (counters.current[backend] ?? 0) + 1;
    const argv = argvForAgent(backend, agentName);
    const labelSuffix = agentName ? ` (${agentName})` : "";
    const next: Tab = {
      localId: crypto.randomUUID(),
      mode: { kind: "launch", backend, argv },
      backend,
      label: `${BACKEND_LABELS[backend]} ${counters.current[backend]}${labelSuffix}`,
    };
    setTabs((prev) => [...prev, next]);
    setActiveId(next.localId);
  }

  async function closeTab(localId: string) {
    const agentId = sessionIds.current.get(localId);
    if (agentId) {
      await killAgent(agentId).catch(() => {});
      clearAgentLabel(agentId);
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
    // Sync runs from the `tabs`-watching useEffect after commit.
  }

  function onTabDragStart(e: React.DragEvent, localId: string) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", localId);
    // Set the ref synchronously so dragover/drop handlers don't have to
    // wait for React to commit the state update (the first dragover
    // event can fire before the rerender, leaving `dragLocalId` null
    // and the browser showing a "no drop here" cursor).
    dragLocalIdRef.current = localId;
    setDragLocalId(localId);
  }

  function onTabDragOver(e: React.DragEvent, overLocalId: string) {
    // Always preventDefault — that's the standard "this element accepts
    // drops" signal. Without it the browser paints the green-plus
    // copy cursor and never fires `drop`.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverLocalId !== overLocalId) setDragOverLocalId(overLocalId);
  }

  function onTabDrop(e: React.DragEvent, targetLocalId: string) {
    e.preventDefault();
    const fromId =
      e.dataTransfer.getData("text/plain") || dragLocalIdRef.current;
    dragLocalIdRef.current = null;
    setDragLocalId(null);
    setDragOverLocalId(null);
    if (!fromId || fromId === targetLocalId) return;
    setTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.localId === fromId);
      const toIdx = prev.findIndex((t) => t.localId === targetLocalId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      // Drop semantics:
      //   forward  drag (fromIdx < toIdx) → land AFTER target
      //   backward drag (fromIdx > toIdx) → land AT target (push right)
      // Both reduce to `splice(toIdx, 0, moved)` after the
      // forward-removal: in `next`, the target is at toIdx-1, so toIdx
      // is "one past target" (after); for backward, the target is
      // still at toIdx and inserting there pushes it right. The
      // forward branch is what lets a tab reach the rightmost slot —
      // anything strictly less than toIdx leaves the moved tab one
      // short of last.
      next.splice(toIdx, 0, moved);
      return next;
    });
    // Sync runs from the `tabs`-watching useEffect after commit.
  }

  function onTabDragEnd() {
    dragLocalIdRef.current = null;
    setDragLocalId(null);
    setDragOverLocalId(null);
  }

  const hasTabs = tabs.length > 0;

  return (
    <div className="flex h-full flex-col border-l border-neutral-800 bg-neutral-950">
      <div className="flex shrink-0 items-center justify-end gap-1 border-b border-neutral-800 px-1 py-0.5">
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
        {backendSupportsAgents(backend) && (
          <select
            value={agentName ?? ""}
            onChange={(e) => setAgentName(e.target.value || null)}
            title="Sub-agent profile"
            className="max-w-[12rem] rounded border border-neutral-800 bg-neutral-900 px-1 py-0.5 text-[11px] focus:outline-none"
          >
            <option value="">Default</option>
            {(agentsByBackend[backend] ?? []).map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={onLaunch}
          title="Launch new agent"
          className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-blue-500"
        >
          + Launch
        </button>
      </div>
      {hasTabs && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-800 px-1 py-0.5">
          {tabs.map((tab) => (
            <div
              key={tab.localId}
              onClick={() => setActiveId(tab.localId)}
              draggable
              onDragStart={(e) => onTabDragStart(e, tab.localId)}
              onDragOver={(e) => onTabDragOver(e, tab.localId)}
              onDragLeave={() => {
                if (dragOverLocalId === tab.localId) setDragOverLocalId(null);
              }}
              onDrop={(e) => onTabDrop(e, tab.localId)}
              onDragEnd={onTabDragEnd}
              className={cn(
                "group flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-[11px] border-l-2",
                tab.localId === activeId
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-900",
                // Drop-target indicator: subtle blue left border on the
                // tab being hovered, but suppress on the dragged tab
                // itself to avoid confusing self-drop feedback.
                dragOverLocalId === tab.localId && dragLocalId !== tab.localId
                  ? "border-l-blue-500"
                  : "border-l-transparent",
                dragLocalId === tab.localId && "opacity-50",
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
        </div>
      )}

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
                setAgentLabel(id, tab.label);
                // The mirror-to-store effect above only re-runs when
                // `activeId` changes, not when the session id arrives —
                // push it directly so other parts of the app (send-queue,
                // per-comment Send) see the agent immediately.
                if (tab.localId === activeId) {
                  setActiveAgent(worktreeId, id);
                }
                // A just-launched tab was missing from the persisted
                // order while its session ID was unknown; now that we
                // have it, refresh so a worktree round-trip preserves
                // the new tab's position too. `syncTabOrder` reads the
                // tabs ref so it sees the current array even when the
                // surrounding closure is stale.
                syncTabOrder();
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function AgentInstance({
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
    // Cmd+click on file paths opens them in the editor; on URLs, in
    // the system browser.
    const termLinks = registerTerminalLinks(term, worktreeId);
    // Cmd+F overlay search.
    const search = attachTerminalSearch(term, host);

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
            mode.argv,
          );
          id = s.id;
          // Cleanup may have fired while launchAgent was in flight —
          // worktree switch mid-launch, or React StrictMode's
          // mount-unmount-mount cycle in dev. The session is alive on
          // the Rust side; kill it now so it doesn't reappear as a
          // duplicate tab on next worktree visit.
          if (disposed) {
            await killAgent(id).catch(() => {});
            return;
          }
        } else {
          const s = await attachAgent(mode.agentId, onEvent);
          id = s.id;
          if (disposed) return;
        }
        agentIdRef.current = id;
        onSession(id);

        term.onData((data) => {
          if (agentIdRef.current) {
            agentWrite(agentIdRef.current, encoder.encode(data)).catch(() => {});
          }
        });
        // xterm collapses Shift+Enter to plain `\r` by default, so agents
        // submit instead of inserting a newline. Intercept and emit the
        // alt+enter sequence (ESC + CR) — the convention readline /
        // Ink-based TUIs (Claude Code, Codex) respect as "literal
        // newline" regardless of continuation-mode state.
        // preventDefault is load-bearing: returning false suppresses
        // xterm's keydown handling but the hidden-textarea browser default
        // would still fire, inserting a stray `\n` that confuses the TUI.
        term.attachCustomKeyEventHandler((ev) => {
          if (search.tryHandleKey(ev)) return false;
          if (ev.type === "keydown" && ev.key === "Enter" && ev.shiftKey) {
            ev.preventDefault();
            if (agentIdRef.current) {
              agentWrite(
                agentIdRef.current,
                encoder.encode("\x1b\r"),
              ).catch(() => {});
            }
            return false;
          }
          return true;
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
      termLinks.dispose();
      search.dispose();
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
