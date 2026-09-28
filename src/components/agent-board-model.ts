/// Pure logic for the agent board: which column a session lands in,
/// what its one-line summary says, and the order cards appear in.
/// Kept out of the component so the rules are unit-testable.

import type {
  AgentBackendKind,
  AgentOverview,
  AgentSessionId,
} from "@/ipc/types";

export type BoardColumn = "blocked" | "review" | "working" | "quiet";

export const BOARD_COLUMNS: { key: BoardColumn; label: string }[] = [
  { key: "blocked", label: "Needs you" },
  { key: "review", label: "Ready to review" },
  { key: "working", label: "Working" },
  { key: "quiet", label: "Quiet" },
];

/// Epoch ms the user last had each session on screen (its tab active in
/// the selected worktree). A finished turn is "ready to review" until
/// the user looks at the agent after it ended.
export type SeenAt = Record<AgentSessionId, number>;

export function columnOf(o: AgentOverview, seenAt: SeenAt): BoardColumn {
  switch (o.activity) {
    case "needsAttention":
      return "blocked";
    case "working":
      return "working";
    case "idle":
      return (seenAt[o.session.id] ?? 0) < o.changedAt ? "review" : "quiet";
    default:
      return "quiet";
  }
}

/// Cards per column, in the order the board shows them. Blocked and
/// review list the longest-waiting first; quiet lists the most recent
/// first since old quiet agents matter least.
export function groupBoard(
  overviews: AgentOverview[],
  seenAt: SeenAt,
): Record<BoardColumn, AgentOverview[]> {
  const out: Record<BoardColumn, AgentOverview[]> = {
    blocked: [],
    review: [],
    working: [],
    quiet: [],
  };
  for (const o of overviews) out[columnOf(o, seenAt)].push(o);
  out.blocked.sort((a, b) => a.changedAt - b.changedAt);
  out.review.sort((a, b) => a.changedAt - b.changedAt);
  out.working.sort((a, b) => a.changedAt - b.changedAt);
  out.quiet.sort((a, b) => b.changedAt - a.changedAt);
  return out;
}

/// Flat keyboard-navigation order: columns left to right, top to bottom.
export function boardOrder(
  grouped: Record<BoardColumn, AgentOverview[]>,
): AgentOverview[] {
  return BOARD_COLUMNS.flatMap((c) => grouped[c.key]);
}

export const BACKEND_LABELS: Record<AgentBackendKind, string> = {
  claudeCode: "Claude",
  codex: "Codex",
  kiro: "Kiro",
};

/// Tab labels as AgentPane numbers them: per worktree, per backend, in
/// `startedAt` order, plus the `--agent` name. AgentPane publishes the
/// label it actually rendered to the UI store; this is the fallback for
/// worktrees whose pane hasn't mounted this run.
export function fallbackLabels(
  overviews: AgentOverview[],
): Record<AgentSessionId, string> {
  const sorted = [...overviews].sort(
    (a, b) => Number(a.session.startedAt) - Number(b.session.startedAt),
  );
  const counters = new Map<string, number>();
  const out: Record<AgentSessionId, string> = {};
  for (const o of sorted) {
    const key = `${o.session.worktreeId}:${o.session.backend}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    const argv = o.session.argv;
    const i = argv.indexOf("--agent");
    const suffix = i >= 0 && i + 1 < argv.length ? ` (${argv[i + 1]})` : "";
    out[o.session.id] = `${BACKEND_LABELS[o.session.backend]} ${n}${suffix}`;
  }
  return out;
}

/// The card's summary line for its current state. The last prompt
/// (`o.task`) has its own line on the card, so it's never repeated here,
/// and a permission prompt renders separately. The agent's last reply is
/// deliberately left off: title + prompt say enough at a glance.
export function summaryOf(o: AgentOverview): string | null {
  switch (o.activity) {
    case "needsAttention":
      if (o.pending?.kind === "permission") return null;
      if (o.pending?.kind === "input" && o.pending.message) {
        return o.pending.message;
      }
      return "Waiting for your reply";
    case "working":
      return o.currentTool;
    default:
      if (o.session.status.kind === "exited") return "Exited";
      if (o.session.status.kind === "crashed") return o.session.status.message;
      return null;
  }
}

/// `now`, `42s`, `6m`, `3h`, `2d`.
export function formatAge(changedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - changedAt) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
