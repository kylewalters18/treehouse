/// Pure grouping logic for WorktreeSidebar. Kept out of the component so
/// the "what goes where" rules are unit-testable.

import type {
  AgentActivity,
  Worktree,
  WorktreeActivity,
  WorktreeId,
} from "@/ipc/types";

type ActivityMap = Record<WorktreeId, WorktreeActivity>;

function activityOf(activity: ActivityMap, id: WorktreeId): AgentActivity {
  return activity[id]?.activity ?? "inactive";
}

/// Worktrees the user acknowledged while their agent was idle. An idle
/// agent that finished its turn lands in "Needs you" once; selecting the
/// worktree clears it until the agent does something else.
export type Acks = Record<WorktreeId, true>;

/// Drop acks for worktrees that left `idle` (the next idle is a new
/// turn worth surfacing) and ack the selected worktree if it's idle.
/// Returns `prev` unchanged when nothing moved so callers can skip a
/// re-render.
export function nextAcks(
  prev: Acks,
  activity: ActivityMap,
  selectedId: WorktreeId | null,
): Acks {
  let next: Acks | null = null;
  for (const id of Object.keys(prev) as WorktreeId[]) {
    if (activityOf(activity, id) !== "idle") {
      next ??= { ...prev };
      delete next[id];
    }
  }
  if (
    selectedId &&
    activityOf(activity, selectedId) === "idle" &&
    !prev[selectedId]
  ) {
    next ??= { ...prev };
    next[selectedId] = true;
  }
  return next ?? prev;
}

/// The "Needs you" inbox: agents blocked on input first, then agents
/// that finished a turn and haven't been looked at. Working agents are
/// deliberately absent — they don't need you.
export function inboxWorktrees(
  worktrees: Worktree[],
  activity: ActivityMap,
  acks: Acks,
): Worktree[] {
  const blocked: Worktree[] = [];
  const finished: Worktree[] = [];
  for (const w of worktrees) {
    const act = activityOf(activity, w.id);
    if (act === "needsAttention") blocked.push(w);
    else if (act === "idle" && !acks[w.id]) finished.push(w);
  }
  return [...blocked, ...finished];
}

/// Split a repo's (non-main-clone) worktrees into rows that stay
/// visible and the collapsed "inactive" pile. Input order is preserved
/// so rows don't reshuffle as agent status changes.
///  - active: has a live agent, or unmerged work (ahead / dirty).
///  - inactive: no agent, nothing pending. `merged` demotes a
///    squash-merged branch here even though it's still `ahead`.
export function splitActive(
  worktrees: Worktree[],
  activity: ActivityMap,
): { active: Worktree[]; inactive: Worktree[] } {
  const active: Worktree[] = [];
  const inactive: Worktree[] = [];
  for (const w of worktrees) {
    const a = activity[w.id];
    const hasAgent = activityOf(activity, w.id) !== "inactive";
    const hasWork = !a?.merged && ((a?.ahead ?? 0) > 0 || (a?.dirty ?? false));
    (hasAgent || hasWork ? active : inactive).push(w);
  }
  return { active, inactive };
}

export type StatusCounts = {
  working: number;
  idle: number;
  needsAttention: number;
};

/// Per-repo tally for the section header, so a collapsed repo still
/// shows what its agents are doing.
export function statusCounts(
  worktrees: Worktree[],
  activity: ActivityMap,
): StatusCounts {
  const c: StatusCounts = { working: 0, idle: 0, needsAttention: 0 };
  for (const w of worktrees) {
    const act = activityOf(activity, w.id);
    if (act !== "inactive") c[act] += 1;
  }
  return c;
}
