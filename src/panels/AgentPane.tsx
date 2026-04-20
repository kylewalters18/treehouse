import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import {
  agentResize,
  agentWrite,
  getAgentForWorktree,
  killAgent,
  launchAgent,
} from "@/ipc/client";
import type {
  AgentBackendKind,
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

type RunningState = {
  session: AgentSession;
  term: Terminal;
  fit: FitAddon;
};

function AgentInstance({ worktreeId }: { worktreeId: WorktreeId }) {
  const [existing, setExisting] = useState<AgentSession | null>(null);
  const [launching, setLaunching] = useState(false);
  const [running, setRunning] = useState<RunningState | null>(null);
  const [backend, setBackend] = useState<AgentBackendKind>("claudeCode");
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  // On mount: check if an agent is already running for this worktree.
  useEffect(() => {
    let mounted = true;
    getAgentForWorktree(worktreeId)
      .then((s) => mounted && setExisting(s))
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [worktreeId]);

  // Teardown on worktree change (don't kill — just dispose UI).
  useEffect(() => {
    return () => {
      running?.term.dispose();
    };
  }, [running]);

  async function onLaunch() {
    const host = hostRef.current;
    if (!host || launching) return;
    setLaunching(true);
    setError(null);

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

    const encoder = new TextEncoder();
    let idRef: AgentSessionId | null = null;

    try {
      const session = await launchAgent(
        worktreeId,
        backend,
        term.cols,
        term.rows,
        (ev) => {
          if (ev.kind === "data") {
            term.write(new Uint8Array(ev.bytes));
          } else if (ev.kind === "status") {
            if (
              ev.status.kind === "exited" ||
              ev.status.kind === "crashed"
            ) {
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
        },
      );
      idRef = session.id;
      setRunning({ session, term, fit });
      setExisting(session);

      term.onData((data) => {
        if (idRef) {
          agentWrite(idRef, encoder.encode(data)).catch(() => {});
        }
      });
      term.onResize(({ cols, rows }) => {
        if (idRef) {
          agentResize(idRef, cols, rows).catch(() => {});
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
      setError(asMessage(e));
    } finally {
      setLaunching(false);
    }
  }

  async function onKill() {
    if (running) {
      await killAgent(running.session.id).catch(() => {});
      running.term.dispose();
      setRunning(null);
      setExisting(null);
    } else if (existing) {
      await killAgent(existing.id).catch(() => {});
      setExisting(null);
    }
  }

  const statusLabel = useMemo(() => {
    if (running) return "running";
    if (existing) return "running (reattach lost — restart to view)";
    return "not running";
  }, [running, existing]);

  const canLaunch = !running && !existing && !launching;

  return (
    <div className="flex h-full flex-col border-l border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-neutral-200">Agent</span>
          <span className="text-neutral-500">·</span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-mono",
              running
                ? "bg-emerald-900/40 text-emerald-300"
                : "bg-neutral-800 text-neutral-400",
            )}
          >
            {statusLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {canLaunch && (
            <>
              <select
                value={backend}
                onChange={(e) => setBackend(e.target.value as AgentBackendKind)}
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] focus:outline-none"
              >
                {BACKENDS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
              <button
                onClick={onLaunch}
                disabled={launching}
                className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                Launch
              </button>
            </>
          )}
          {(running || existing) && (
            <button
              onClick={onKill}
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
        {!running && !existing && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-600">
            Pick a backend and click Launch
          </div>
        )}
        {existing && !running && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-500">
            Agent is running but this window lost its live stream. Kill and
            relaunch to view output.
          </div>
        )}
        <div
          ref={hostRef}
          className={cn(
            "absolute inset-0 p-2",
            (!running || launching) && "pointer-events-none opacity-0",
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
