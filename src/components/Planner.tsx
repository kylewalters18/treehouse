/// ⌘J planner popup. Each open repo has its own planner — an agent for
/// brainstorming and turning decisions into issues and worktrees, running in
/// a read-only copy of `origin/<default>` rather than the user's checkout
/// (see `src-tauri/src/planner.rs`) — and "Global" is the repo-less scratch
/// agent (`scratch.rs`). Planners are tabs, each with its activity dot. ⌘J
/// opens the current repo's planner; picking another tab sticks until you
/// move to a different repo.
///
/// With no session yet the popup shows a landing view (prompt box, starters,
/// recent conversations); a repo planner can also show its issue drawer, and
/// flags when origin has moved past what it's reading.
///
/// New sessions run over ACP (a structured transcript, `AcpAgentSlot`);
/// resuming a non-Claude conversation still uses a terminal. Hiding only
/// detaches the view — every planner keeps running and its conversation is
/// there next time. Past conversations are listed under
/// History and resume in place (each planner's directory is stable). Esc is
/// deliberately NOT a close key: Claude uses it.

import { useEffect, useReducer, useRef, useState } from "react";

import {
  forgetAgentSession,
  killAgent,
  listPlannerHistory,
  plannerActivities,
  plannerCommitsBehind,
} from "@/ipc/client";
import type {
  AgentActivity,
  AgentHistoryEntry,
  AgentTransport,
  ForgeIssue,
  PlannerCheckout,
  WorkspaceId,
  WorktreeId,
} from "@/ipc/types";
import { pasteText } from "@/lib/agent";
import { cn } from "@/lib/cn";
import { resolvePlannerScope } from "@/lib/planner-scope";
import {
  createAgentLeafState,
  detachAgentLeafState,
  type AgentLeafState,
} from "@/panels/agent-leaf-state";
import { fitAndPin } from "@/panels/xterm-fit";
import {
  createAcpLeafState,
  detachAcpLeafState,
  type AcpLeafState,
} from "@/panels/acp-leaf-state";
import { AcpAgentSlot } from "@/panels/AcpAgentSlot";
import { AgentHistoryMenu, HistoryIcon } from "@/panels/AgentHistory";
import { useForgeStore } from "@/stores/forge";
import { useUiStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import { PlannerIssues } from "./PlannerIssues";
import { PlannerLanding } from "./PlannerLanding";

const POLL_MS = 1500;
/// How often an open repo planner re-checks origin for new commits.
const BEHIND_POLL_MS = 3 * 60_000;
const GLOBAL = "global";

/// A planner's view state: an xterm (PTY) or an ACP transcript. `id`
/// distinguishes successive leaves under one key, so a replaced session
/// remounts its view.
type PlannerLeaf =
  | { kind: "pty"; id: number; state: AgentLeafState }
  | { kind: "acp"; id: number; state: AcpLeafState };
let nextLeafId = 1;

/// Module-level so each planner's view (xterm scrollback, ACP transcript)
/// survives the popup unmounting between opens and switching between
/// planners — same idea as the AgentPane leaf pools. Keyed by workspace id,
/// or `GLOBAL`. No leaf = no session yet: the popup shows the landing view.
const leaves = new Map<string, PlannerLeaf>();
/// The ACP leaves' states by key, in the shape `AcpAgentSlot` adopts from.
const acpStates = new Map<string, AcpLeafState>();
/// What each repo planner is reading, once its session is up.
const checkouts = new Map<string, PlannerCheckout | null>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const cb of listeners) cb();
};

function keyOf(scope: WorkspaceId | null): string {
  return scope ?? GLOBAL;
}

/// Drop a planner's leaf (its session, if any, is the caller's business).
function dropLeaf(key: string) {
  const leaf = leaves.get(key);
  leaves.delete(key);
  acpStates.delete(key);
  checkouts.delete(key);
  if (leaf?.kind === "pty") detachAgentLeafState(leaf.state);
  if (leaf?.kind === "acp") detachAcpLeafState(leaf.state);
}

/// Start (or, with `resume`, replace) the planner's session over
/// `transport`. `prompt` is a new session's first message.
function startLeaf(
  scope: WorkspaceId | null,
  opts: { resume?: string; prompt?: string; transport?: AgentTransport } = {},
): PlannerLeaf {
  const key = keyOf(scope);
  if (opts.resume || leaves.get(key)?.state.exited) dropLeaf(key);
  let leaf = leaves.get(key);
  if (!leaf) {
    const mode = {
      kind: "planner" as const,
      workspaceId: scope,
      resume: opts.resume,
      prompt: opts.prompt,
      onCheckout: (c: PlannerCheckout | null) => {
        checkouts.set(key, c);
        notify();
      },
    };
    const id = nextLeafId++;
    if ((opts.transport ?? "acp") === "acp") {
      const state = createAcpLeafState(NO_WORKTREE, mode, notify);
      leaf = { kind: "acp", id, state };
      acpStates.set(key, state);
    } else {
      leaf = { kind: "pty", id, state: createAgentLeafState(null, mode, notify) };
    }
    leaves.set(key, leaf);
  }
  return leaf;
}

/// Planners aren't worktrees; the ACP pane's worktree-only affordances
/// (`@file` completion, opening files) stay inert.
const NO_WORKTREE = "" as WorktreeId;

/// Claude conversations reopen over ACP; other backends' saved ids belong
/// to their CLIs, so those resume in a terminal.
function resumeTransport(entry: AgentHistoryEntry): AgentTransport {
  return entry.backend === "claudeCode" ? "acp" : "pty";
}

/// Every planner's activity, polled while `enabled` (global key = `GLOBAL`).
function usePlannerActivities(enabled: boolean): Map<string, AgentActivity> {
  const [activities, setActivities] = useState<Map<string, AgentActivity>>(new Map());
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = () =>
      plannerActivities()
        .then(
          (list) =>
            !cancelled &&
            setActivities(new Map(list.map((a) => [keyOf(a.workspaceId), a.activity]))),
        )
        .catch(() => {});
    tick();
    const t = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [enabled]);
  return activities;
}

/// The status dot's color for a planner (`undefined` = no session).
function dotClass(activity: AgentActivity | undefined): string {
  return activity === "needsAttention"
    ? "bg-amber-400"
    : activity === "working"
      ? "bg-blue-400"
      : activity === undefined || activity === "inactive"
        ? "bg-neutral-600"
        : "bg-emerald-400";
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
  const issuesOpen = useUiStore((s) => s.plannerIssuesOpen);
  const setIssuesOpen = useUiStore((s) => s.setPlannerIssuesOpen);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const currentRepo = useCurrentRepo();
  const scope = usePlannerScope();
  const key = keyOf(scope);
  const forgeStatus = useForgeStore((s) => (scope ? s.status[scope] : undefined));
  const loadForgeStatus = useForgeStore((s) => s.loadStatus);
  const activities = usePlannerActivities(open);
  const slotRef = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<AgentHistoryEntry[]>([]);
  /// Landing-view prompt drafts, per planner.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [behind, setBehind] = useState<number | null>(null);
  /// Issue references bound for an ACP planner's composer.
  const [insert, setInsert] = useState<{ text: string; nonce: number } | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, []);

  // A session that ended (`/exit`, a crash, its repo closed) goes back to
  // the landing view on the next open rather than showing a tombstone.
  useEffect(() => {
    if (open && leaves.get(key)?.state.exited) {
      dropLeaf(key);
      rerender();
    }
  }, [open, key]);

  useEffect(() => {
    if (!open) return;
    const slot = slotRef.current;
    const leaf = leaves.get(key);
    if (!slot || leaf?.kind !== "pty") return;
    const state = leaf.state;
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
  }, [open, key, generation]);

  // Switching planners closes the history list (it's per planner).
  useEffect(() => setHistoryOpen(false), [scope, open]);

  const leaf = leaves.get(key);
  const landing = !leaf;
  const ready = leaf?.state.sessionId != null;
  const checkout = checkouts.get(key) ?? null;
  const repo = scope ? workspaces.find((w) => w.id === scope) : undefined;
  const forgeReady = !!repo && !!forgeStatus?.authenticated;

  useEffect(() => {
    if (open && scope) void loadForgeStatus(scope);
  }, [open, scope, loadForgeStatus]);

  // The landing view lists recent conversations.
  useEffect(() => {
    if (!open || !landing) return;
    let live = true;
    listPlannerHistory(scope)
      .then((h) => live && setHistory(h))
      .catch(() => live && setHistory([]));
    return () => {
      live = false;
    };
  }, [open, landing, scope]);

  // New commits on origin since this planner's checkout.
  const sha = checkout?.sha;
  useEffect(() => {
    setBehind(null);
    if (!open || !scope || !sha) return;
    let live = true;
    const check = () =>
      plannerCommitsBehind(scope)
        .then((n) => live && setBehind(n))
        .catch(() => {});
    check();
    const t = window.setInterval(check, BEHIND_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [open, scope, sha]);

  if (!open) return null;

  function pickScope(next: WorkspaceId | null) {
    setPick({ scope: next, forRepo: currentRepo });
  }

  function start(prompt?: string) {
    startLeaf(scope, { prompt });
    setDrafts((d) => ({ ...d, [key]: "" }));
    setGeneration((g) => g + 1);
  }

  async function toggleHistory() {
    if (historyOpen) return setHistoryOpen(false);
    setHistory(await listPlannerHistory(scope).catch(() => []));
    setHistoryOpen(true);
  }

  function resume(entry: AgentHistoryEntry) {
    setHistoryOpen(false);
    // Already the conversation on screen → nothing to do.
    if (entry.liveAgentId && entry.liveAgentId === leaf?.state.sessionId) return;
    startLeaf(scope, { resume: entry.sessionId, transport: resumeTransport(entry) });
    setGeneration((g) => g + 1);
  }

  async function forget(entry: AgentHistoryEntry) {
    await forgetAgentSession(entry.sessionId).catch(() => {});
    setHistory(await listPlannerHistory(scope).catch(() => []));
  }

  /// Kill this planner's session and go back to the landing view.
  async function newSession() {
    const old = leaves.get(key);
    // Wait for the kill before showing the landing view, so a quick restart
    // can't race it and re-attach to the dying session. The next start
    // refreshes the checkout.
    if (old?.state.sessionId) await killAgent(old.state.sessionId).catch(() => {});
    dropLeaf(key);
    setGeneration((g) => g + 1);
  }

  /// Bring the checkout up to date without losing the conversation: resume
  /// the running conversation, which refreshes the checkout on relaunch.
  async function refreshCheckout() {
    const sessionId = leaf?.state.sessionId;
    const entries = await listPlannerHistory(scope).catch(() => []);
    const current = entries.find((e) => e.liveAgentId && e.liveAgentId === sessionId);
    if (!current) return void newSession();
    startLeaf(scope, { resume: current.sessionId, transport: leaf?.kind });
    setGeneration((g) => g + 1);
  }

  function insertIssue(issue: ForgeIssue) {
    const ref = `#${issue.number} ${issue.title}`;
    if (!leaf) {
      setDrafts((d) => {
        const cur = d[key] ?? "";
        return { ...d, [key]: cur ? `${cur.trimEnd()} ${ref} ` : `${ref} ` };
      });
      return;
    }
    if (leaf.kind === "acp") {
      setInsert((prev) => ({ text: `${ref} `, nonce: (prev?.nonce ?? 0) + 1 }));
      return;
    }
    if (!leaf.state.sessionId) return;
    void pasteText(leaf.state.sessionId, `${ref} `);
    leaf.state.term.focus();
  }

  function startWorktree(issue: ForgeIssue) {
    if (!scope) return;
    setOpen(false);
    useUiStore.getState().openNewWorktreeDialog(scope, issue);
  }

  const tabs: { key: string; scope: WorkspaceId | null; label: string }[] = [
    ...workspaces.map((w) => ({ key: w.id, scope: w.id, label: repoName(w.root) })),
    { key: GLOBAL, scope: null, label: "Global" },
  ];

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
        className={cn(
          "flex h-[78vh] w-full flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl",
          issuesOpen && forgeReady ? "max-w-[1300px]" : "max-w-[1100px]",
        )}
      >
        <div className="relative flex items-end gap-0.5 border-b border-neutral-800 bg-neutral-950/50 px-3 pt-2 text-xs">
          <div role="tablist" aria-label="Planners" className="flex min-w-0 items-end gap-0.5 overflow-x-auto">
            {tabs.map((t) => {
              const activity = activities.get(t.key);
              const active = t.key === key;
              const waiting = activity === "needsAttention";
              return (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => pickScope(t.scope)}
                  title={t.scope ? `${t.label} planner` : "Global planner — not tied to a repo"}
                  className={cn(
                    "flex h-[30px] shrink-0 items-center gap-1.5 rounded-t-md px-3",
                    active
                      ? "bg-neutral-900 text-neutral-100 shadow-[inset_0_2px_0_#60a5fa]"
                      : "text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", dotClass(activity))} />
                  {t.label}
                  {waiting && !active && (
                    <span className="text-[10px] text-amber-400">needs you</span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex-1" />
          {!landing && (
            <>
              <button
                data-agent-history-toggle
                onClick={() => void toggleHistory()}
                title="Past planning sessions — click one to resume"
                className={cn(
                  "mb-1 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-neutral-800 hover:text-neutral-200",
                  historyOpen ? "bg-neutral-800 text-neutral-200" : "text-neutral-500",
                )}
              >
                <HistoryIcon />
                History
              </button>
              <button
                onClick={() => void newSession()}
                title="End this session (it stays in History) and start over"
                className="mb-1 shrink-0 rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              >
                New session
              </button>
            </>
          )}
          <button
            onClick={() => setOpen(false)}
            title="Hide (the session keeps running)"
            className="mb-1 shrink-0 rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
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
        <div className="flex items-center gap-2.5 border-b border-neutral-800 px-3 py-1.5 text-xs text-neutral-500">
          {forgeReady && (
            <button
              onClick={() => setIssuesOpen(!issuesOpen)}
              aria-pressed={issuesOpen}
              title="Show the repo's issues beside the planner"
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5",
                issuesOpen
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200",
              )}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16" />
              </svg>
              Issues
            </button>
          )}
          <span className="min-w-0 truncate">
            {!repo ? (
              "Not tied to a repo · names one per call"
            ) : landing ? (
              <>
                starts on the latest <span className="font-mono text-neutral-400">origin/{repo.defaultBranch}</span> ·
                can't edit code
              </>
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
          {!landing && ready && behind != null && behind > 0 && (
            <button
              onClick={() => void refreshCheckout()}
              title="Restart this conversation on the latest commits (it picks up where it left off)"
              className="flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-950/30 px-2 py-px text-[11px] text-amber-300 hover:bg-amber-950/60"
            >
              ↑ {behind} new commit{behind === 1 ? "" : "s"} on {checkout?.baseRef ?? "origin"} · Refresh
            </button>
          )}
          {checkout?.warning && (
            <span className="shrink-0 rounded bg-amber-950/50 px-1.5 text-amber-300" title={checkout.warning}>
              {checkout.warning}
            </span>
          )}
        </div>
        {error && leaf?.kind === "pty" && (
          <div className="m-3 shrink-0 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          {issuesOpen && forgeReady && scope && (
            <PlannerIssues
              key={scope}
              workspaceId={scope}
              onInsert={insertIssue}
              onStart={startWorktree}
              onOpenWorktree={(wt) => {
                useUiStore.getState().selectWorktree(wt.id);
                setOpen(false);
              }}
            />
          )}
          <div className="relative min-w-0 flex-1 bg-[#0F1114]">
            {landing ? (
              <PlannerLanding
                repoName={repo ? repoName(repo.root) : null}
                draft={drafts[key] ?? ""}
                setDraft={(v) => setDrafts((d) => ({ ...d, [key]: v }))}
                history={history}
                onStart={start}
                onResume={resume}
              />
            ) : leaf.kind === "acp" ? (
              <div className="absolute inset-0 overflow-hidden">
                <AcpAgentSlot
                  key={leaf.id}
                  worktreeId={NO_WORKTREE}
                  mode={{ kind: "attach", agentId: leaf.state.sessionId ?? "" }}
                  poolKey={key}
                  visible={open}
                  leafStates={acpStates}
                  onSession={() => {}}
                  insertRequest={insert}
                />
              </div>
            ) : (
              <div ref={slotRef} className="absolute inset-0 overflow-hidden" />
            )}
          </div>
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
  const [hasSession, setHasSession] = useState(() =>
    [...leaves.values()].some((l) => l.state.sessionId != null),
  );

  useEffect(() => {
    const cb = () => setHasSession([...leaves.values()].some((l) => l.state.sessionId != null));
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);

  const activities = usePlannerActivities(hasSession);

  const waitingKey = open
    ? undefined
    : [...activities].find(([, a]) => a === "needsAttention")?.[0];
  const waiting = waitingKey === undefined ? undefined : { key: waitingKey };
  const mine = activities.get(keyOf(scope)) ?? "inactive";
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
