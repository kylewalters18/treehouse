import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import {
  agentResize,
  agentWrite,
  attachAgent,
  getAgentForWorktree,
  killAgent,
  launchAgent,
} from "@/ipc/client";
import type {
  AgentBackendKind,
  AgentEvent,
  AgentSession,
  AgentSessionId,
  WorktreeId,
} from "@/ipc/types";
import { cn } from "@/lib/cn";

const BACKENDS: { label: string; value: AgentBackendKind }[] = [
  { label: "Claude Code", value: "claudeCode" },
  { label: "Codex", value: "codex" },
  { label: "Aider", value: "aider" },
  { label: "Generic CLI", value: "genericCli" },
];

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
  return <AgentInstance key={worktreeId} worktreeId={worktreeId} />;
}

function AgentInstance({ worktreeId }: { worktreeId: WorktreeId }) {
  const [session, setSession] = useState<AgentSession | null>(null);
  const [launching, setLaunching] = useState(false);
  const [exited, setExited] = useState(false);
  const [backend, setBackend] = useState<AgentBackendKind>("claudeCode");
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<AgentSessionId | null>(null);

  // On mount: if an agent is already running for this worktree, auto-attach
  // and replay its output. Otherwise wait for the user to click Launch.
  useEffect(() => {
    let cancelled = false;
    getAgentForWorktree(worktreeId)
      .then(async (existing) => {
        if (cancelled || !existing) return;
        await mountTerminal({ reattach: existing.id });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      idRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId]);

  async function mountTerminal({
    launch,
    reattach,
  }: {
    launch?: AgentBackendKind;
    reattach?: AgentSessionId;
  }) {
    const host = hostRef.current;
    if (!host) return;

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
          setExited(true);
          const suffix =
            ev.status.kind === "exited"
              ? ev.status.code !== null
                ? ` (code ${ev.status.code})`
                : ""
              : `: ${ev.status.message}`;
          term.write(
            `\r\n\x1b[38;2;115;115;115m[agent ${ev.status.kind}${suffix}]\x1b[0m\r\n`,
          );
        }
      }
    };

    try {
      const s = reattach
        ? await attachAgent(reattach, onEvent)
        : await launchAgent(
            worktreeId,
            launch ?? "claudeCode",
            term.cols,
            term.rows,
            onEvent,
          );
      idRef.current = s.id;
      setSession(s);

      term.onData((data) => {
        if (idRef.current) {
          agentWrite(idRef.current, encoder.encode(data)).catch(() => {});
        }
      });
      term.onResize(({ cols, rows }) => {
        if (idRef.current) {
          agentResize(idRef.current, cols, rows).catch(() => {});
        }
      });
      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {}
      });
      ro.observe(host);
    } catch (e: unknown) {
      term.dispose();
      termRef.current = null;
      setError(asMessage(e));
    }
  }

  async function onLaunchClick() {
    if (launching) return;
    setLaunching(true);
    setError(null);
    setExited(false);
    await mountTerminal({ launch: backend });
    setLaunching(false);
  }

  async function onKillClick() {
    if (session) {
      await killAgent(session.id).catch(() => {});
    }
    termRef.current?.dispose();
    termRef.current = null;
    fitRef.current = null;
    idRef.current = null;
    setSession(null);
    setExited(false);
  }

  const statusLabel = !session
    ? "not running"
    : exited
      ? "exited"
      : "running";

  return (
    <div className="flex h-full flex-col border-l border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-neutral-200">Agent</span>
          <span className="text-neutral-500">·</span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-mono",
              session && !exited
                ? "bg-emerald-900/40 text-emerald-300"
                : exited
                  ? "bg-amber-900/40 text-amber-300"
                  : "bg-neutral-800 text-neutral-400",
            )}
          >
            {statusLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!session && (
            <>
              <select
                value={backend}
                onChange={(e) => setBackend(e.target.value as AgentBackendKind)}
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] focus:outline-none"
                disabled={launching}
              >
                {BACKENDS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
              <button
                onClick={onLaunchClick}
                disabled={launching}
                className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {launching ? "Launching…" : "Launch"}
              </button>
            </>
          )}
          {session && (
            <button
              onClick={onKillClick}
              className="rounded border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-red-800 hover:text-red-400"
            >
              Kill
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="m-3 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="relative flex-1">
        {!session && !launching && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-600">
            Pick a backend and click Launch
          </div>
        )}
        <div
          ref={hostRef}
          className={cn(
            "absolute inset-0 p-2",
            !session && "pointer-events-none opacity-0",
          )}
        />
      </div>
    </div>
  );
}

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return e instanceof Error ? e.message : String(e);
}
