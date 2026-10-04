/// ⌘J planner popup. Each open repo has its own planner — an agent for
/// brainstorming and turning decisions into issues and worktrees, running in
/// a read-only copy of `origin/<default>` rather than the user's checkout
/// (see `src-tauri/src/planner.rs`) — and "Global" is the repo-less scratch
/// agent (`scratch.rs`). ⌘J opens the current repo's planner; picking
/// another in the header sticks until you move to a different repo.
///
/// Hiding only detaches the xterm — every planner keeps running and its
/// conversation is there next time. Past conversations are listed under
/// History and resume in place (each planner's directory is stable). Esc is deliberately NOT a close key:
/// Claude uses it.

import { useEffect, useReducer, useRef, useState } from "react";

import {
  forgetAgentSession,
  killAgent,
  listPlannerHistory,
  plannerActivities,
} from "@/ipc/client";
import type {
  AgentActivity,
  AgentHistoryEntry,
  PlannerCheckout,
  WorkspaceId,
} from "@/ipc/types";
import { cn } from "@/lib/cn";
import { resolvePlannerScope } from "@/lib/planner-scope";
import {
  createAgentLeafState,
  detachAgentLeafState,
  type AgentLeafState,
} from "@/panels/agent-leaf-state";
import { fitAndPin } from "@/panels/xterm-fit";
import { AgentHistoryMenu, HistoryIcon } from "@/panels/AgentHistory";
import { useUiStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";

const POLL_MS = 1500;
const GLOBAL = "global";

/// Module-level so each planner's xterm (scrollback, selection) survives the
/// popup unmounting between opens and switching between planners — same idea
/// as the AgentPane leaf pool. Keyed by workspace id, or `GLOBAL`.
const leaves = new Map<string, AgentLeafState>();
/// What each repo planner is reading, once its session is up.
const checkouts = new Map<string, PlannerCheckout | null>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const cb of listeners) cb();
};

function keyOf(scope: WorkspaceId | null): string {
  return scope ?? GLOBAL;
}

/// The planner's leaf, created on first use. `resume` replaces it with a
/// past conversation (Rust swaps the running session for it).
function ensureLeaf(scope: WorkspaceId | null, resume?: string): AgentLeafState {
  const key = keyOf(scope);
  let leaf = leaves.get(key);
  if (leaf && resume) {
    detachAgentLeafState(leaf);
    leaves.delete(key);
    checkouts.delete(key);
    leaf = undefined;
  }
  if (leaf && leaf.exited) {
    // `/exit`, a crash, or its repo was closed: start over rather than
    // showing a tombstone.
    detachAgentLeafState(leaf);
    leaves.delete(key);
    checkouts.delete(key);
    leaf = undefined;
  }
  if (!leaf) {
    leaf = createAgentLeafState(
      null,
      {
        kind: "planner",
        workspaceId: scope,
        resume,
        onCheckout: (c) => {
          checkouts.set(key, c);
          notify();
        },
      },
      notify,
    );
    leaves.set(key, leaf);
  }
  return leaf;
}

/// The repo ⌘J is "in": the selected worktree's, else the only/first open
/// repo; null (global) with none open.
function useCurrentRepo(): WorkspaceId | null {
  const selected = useUiStore((s) => s.selectedWorktreeId);
  const wtRepo = useWorktreesStore(
    (s) => s.worktrees.find((w) => w.id === selected)?.workspaceId ?? null,
  );
  const firstRepo = useWorkspaceStore((s) => s.workspaces[0]?.id ?? null);
  return wtRepo ?? firstRepo;
}

function usePlannerScope(): WorkspaceId | null {
  const current = useCurrentRepo();
  const pick = useUiStore((s) => s.plannerPick);
  const openIds = useWorkspaceStore((s) => s.workspaces.map((w) => w.id).join("\n"));
  return resolvePlannerScope(current, pick, openIds ? openIds.split("\n") : []);
}

function repoName(root: string): string {
  return root.split("/").filter(Boolean).pop() ?? root;
}

export function PlannerPopup() {
  const open = useUiStore((s) => s.plannerOpen);
  const setOpen = useUiStore((s) => s.setPlannerOpen);
  const setPick = useUiStore((s) => s.setPlannerPick);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const currentRepo = useCurrentRepo();
  const scope = usePlannerScope();
  const slotRef = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<AgentHistoryEntry[]>([]);
  /// A conversation to resume on the next mount of the slot.
  const resumeRef = useRef<string | undefined>(undefined);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const slot = slotRef.current;
    if (!slot) return;
    const state = ensureLeaf(scope, resumeRef.current);
    resumeRef.current = undefined;
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
  }, [open, scope, generation]);

  // Switching planners closes the history list (it's per planner).
  useEffect(() => setHistoryOpen(false), [scope, open]);

  if (!open) return null;

  const key = keyOf(scope);
  const leaf = leaves.get(key);
  const ready = leaf?.sessionId != null;
  const checkout = checkouts.get(key) ?? null;
  const repo = scope ? workspaces.find((w) => w.id === scope) : undefined;

  async function toggleHistory() {
    if (historyOpen) return setHistoryOpen(false);
    setHistory(await listPlannerHistory(scope).catch(() => []));
    setHistoryOpen(true);
  }

  function resume(entry: AgentHistoryEntry) {
    setHistoryOpen(false);
    // Already the conversation on screen → nothing to do.
    if (entry.liveAgentId && entry.liveAgentId === leaf?.sessionId) return;
    resumeRef.current = entry.claudeSessionId;
    setGeneration((g) => g + 1);
  }

  async function forget(entry: AgentHistoryEntry) {
    await forgetAgentSession(entry.claudeSessionId).catch(() => {});
    setHistory(await listPlannerHistory(scope).catch(() => []));
  }

  async function newSession() {
    const old = leaves.get(key);
    leaves.delete(key);
    checkouts.delete(key);
    if (old) {
      detachAgentLeafState(old);
      // Wait for the kill so the relaunch can't race it and re-attach to
      // the dying session. The relaunch refreshes the checkout.
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
        aria-label="Planner"
        className="flex h-[78vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl"
      >
        <div className="relative flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-xs">
          <span className="text-sm font-semibold text-neutral-100">
            {repo ? "Planner" : "Global"}
          </span>
          <select
            value={scope ?? GLOBAL}
            onChange={(e) =>
              setPick({
                scope: e.target.value === GLOBAL ? null : e.target.value,
                forRepo: currentRepo,
              })
            }
            aria-label="Which planner"
            className="rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-neutral-200"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {repoName(w.root)}
              </option>
            ))}
            <option value={GLOBAL}>Global (any repo)</option>
          </select>
          <span className="min-w-0 truncate text-neutral-500">
            {!repo ? (
              "Not tied to a repo · names one per call"
            ) : !ready ? (
              `Refreshing a read-only copy of origin/${repo.defaultBranch}…`
            ) : checkout ? (
              <>
                reads <span className="font-mono text-neutral-400">{checkout.baseRef}</span> @{" "}
                <span className="font-mono text-neutral-400">{checkout.sha}</span> · can't edit
                code
              </>
            ) : (
              "read-only copy of the default branch"
            )}
          </span>
          {checkout?.warning && (
            <span className="shrink-0 rounded bg-amber-950/50 px-1.5 text-amber-300" title={checkout.warning}>
              {checkout.warning}
            </span>
          )}
          <div className="flex-1" />
          <button
            data-agent-history-toggle
            onClick={() => void toggleHistory()}
            title="Past planning sessions — click one to resume"
            className={cn(
              "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-neutral-800 hover:text-neutral-200",
              historyOpen ? "bg-neutral-800 text-neutral-200" : "text-neutral-500",
            )}
          >
            <HistoryIcon />
            History
          </button>
          <button
            onClick={() => void newSession()}
            title={
              repo
                ? "Kill this session and start fresh on the latest origin"
                : "Kill this session and start a fresh one"
            }
            className="shrink-0 rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            New session
          </button>
          <button
            onClick={() => setOpen(false)}
            title="Hide (the session keeps running)"
            className="shrink-0 rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            ⌘J hide
          </button>
          {historyOpen && (
            <AgentHistoryMenu
              worktreeName={repo ? `${repoName(repo.root)} planner` : "global"}
              entries={history}
              onResume={resume}
              onForget={(e) => void forget(e)}
              onClose={() => setHistoryOpen(false)}
            />
          )}
        </div>
        {error && (
          <div className="m-3 shrink-0 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        <div className="relative flex-1 bg-[#0F1114]">
          <div ref={slotRef} className="absolute inset-0 overflow-hidden" />
        </div>
      </div>
    </div>
  );
}

/// Header pill: toggles the popup, and turns amber when any hidden planner
/// is waiting on the user (e.g. a permission prompt) — opening then jumps to
/// that planner.
export function PlannerPill() {
  const open = useUiStore((s) => s.plannerOpen);
  const toggle = useUiStore((s) => s.togglePlanner);
  const setPick = useUiStore((s) => s.setPlannerPick);
  const currentRepo = useCurrentRepo();
  const scope = usePlannerScope();
  const [activities, setActivities] = useState<{ key: string; activity: AgentActivity }[]>([]);
  const [hasSession, setHasSession] = useState(() =>
    [...leaves.values()].some((l) => l.sessionId != null),
  );

  useEffect(() => {
    const cb = () => setHasSession([...leaves.values()].some((l) => l.sessionId != null));
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    const tick = () =>
      plannerActivities()
        .then(
          (list) =>
            !cancelled &&
            setActivities(list.map((a) => ({ key: keyOf(a.workspaceId), activity: a.activity }))),
        )
        .catch(() => {});
    tick();
    const t = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [hasSession]);

  const waiting = open ? undefined : activities.find((a) => a.activity === "needsAttention");
  const mine = activities.find((a) => a.key === keyOf(scope))?.activity ?? "inactive";
  return (
    <button
      onClick={() => {
        if (waiting) {
          setPick({ scope: waiting.key === GLOBAL ? null : waiting.key, forRepo: currentRepo });
        }
        toggle();
      }}
      title="Planner — this repo's, or global (⌘J)"
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px]",
        waiting
          ? "border-amber-500/60 text-amber-400"
          : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          waiting
            ? "bg-amber-400"
            : mine === "working"
              ? "bg-blue-400"
              : mine === "inactive"
                ? "bg-neutral-600"
                : "bg-emerald-400",
        )}
      />
      {waiting ? "planner needs you" : "planner"}
      <span className="font-mono text-[10px] text-neutral-500">⌘J</span>
    </button>
  );
}
