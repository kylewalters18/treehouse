/// Scratch agent: one global session of the default agent in a ⌘J popup,
/// not tied to any repo (see `src-tauri/src/scratch.rs`). When that's Claude
/// it has the treehouse MCP tools, so it can create worktrees in any open repo. Hiding the popup only detaches
/// the xterm — the process keeps running and the conversation is still there
/// next time. Esc is deliberately NOT a close key: Claude uses it.

import { useEffect, useRef, useState } from "react";

import { killAgent, scratchAgentActivity } from "@/ipc/client";
import type { AgentActivity } from "@/ipc/types";
import { cn } from "@/lib/cn";
import {
  createAgentLeafState,
  detachAgentLeafState,
  type AgentLeafState,
} from "@/panels/agent-leaf-state";
import { fitAndPin } from "@/panels/xterm-fit";
import { useUiStore } from "@/stores/ui";

const POLL_MS = 1500;

/// Module-level so the xterm (scrollback, selection) survives the popup
/// unmounting between opens, same idea as the AgentPane leaf pool.
let leaf: AgentLeafState | null = null;
const leafListeners = new Set<() => void>();

function ensureLeaf(): AgentLeafState {
  if (leaf && leaf.exited) {
    // `/exit` or a crash: start over rather than showing a tombstone.
    detachAgentLeafState(leaf);
    leaf = null;
  }
  if (!leaf) {
    leaf = createAgentLeafState(null, { kind: "scratch" }, () => {
      for (const cb of leafListeners) cb();
    });
  }
  return leaf;
}

export function ScratchAgent() {
  const open = useUiStore((s) => s.scratchOpen);
  const setOpen = useUiStore((s) => s.setScratchOpen);
  const slotRef = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const slot = slotRef.current;
    if (!slot) return;
    const state = ensureLeaf();
    slot.appendChild(state.host);
    setError(state.error);
    state.errorListeners.add(setError);
    try {
      fitAndPin(state.fit, state.term);
    } catch {}
    state.term.focus();
    return () => {
      state.errorListeners.delete(setError);
      if (state.host.parentNode === slot) slot.removeChild(state.host);
    };
  }, [open, generation]);

  if (!open) return null;

  async function newSession() {
    const old = leaf;
    leaf = null;
    if (old) {
      detachAgentLeafState(old);
      // Wait for the kill so the relaunch can't race it and re-attach to
      // the dying session.
      if (old.sessionId) await killAgent(old.sessionId).catch(() => {});
    }
    setGeneration((g) => g + 1);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-6 pt-[6vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-label="Scratch agent"
        className="flex h-[78vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-xs">
          <span className="text-sm font-semibold text-neutral-100">Scratch</span>
          <span className="truncate text-neutral-500">
            Global agent session · not tied to any repo
          </span>
          <div className="flex-1" />
          <button
            onClick={() => void newSession()}
            title="Kill this session and start a fresh one"
            className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            New session
          </button>
          <button
            onClick={() => setOpen(false)}
            title="Hide (the session keeps running)"
            className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            ⌘J hide
          </button>
        </div>
        {error && (
          <div className="m-3 shrink-0 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        <div className="relative flex-1 bg-[#121314]">
          <div ref={slotRef} className="absolute inset-0" />
        </div>
      </div>
    </div>
  );
}

/// Header pill: toggles the popup, and turns amber when the hidden scratch
/// agent is waiting on the user (e.g. a permission prompt).
export function ScratchPill() {
  const open = useUiStore((s) => s.scratchOpen);
  const toggle = useUiStore((s) => s.toggleScratch);
  const [activity, setActivity] = useState<AgentActivity>("inactive");
  const [hasSession, setHasSession] = useState(() => leaf?.sessionId != null);

  useEffect(() => {
    const cb = () => setHasSession(true);
    leafListeners.add(cb);
    return () => {
      leafListeners.delete(cb);
    };
  }, []);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    const tick = () =>
      scratchAgentActivity()
        .then((a) => !cancelled && setActivity(a))
        .catch(() => {});
    tick();
    const t = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [hasSession]);

  const needsYou = activity === "needsAttention" && !open;
  return (
    <button
      onClick={toggle}
      title="Scratch agent (⌘J)"
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2 py-0.5",
        needsYou
          ? "border-amber-500/60 text-amber-400"
          : "border-neutral-700 text-neutral-400 hover:bg-neutral-800",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          needsYou
            ? "bg-amber-400"
            : activity === "working"
              ? "bg-sky-400"
              : activity === "inactive"
                ? "bg-neutral-600"
                : "bg-emerald-400",
        )}
      />
      {needsYou ? "scratch needs you" : "scratch"}
      <span className="font-mono text-[10px] text-neutral-500">⌘J</span>
    </button>
  );
}
