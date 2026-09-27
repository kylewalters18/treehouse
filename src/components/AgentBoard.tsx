/// Agent board: a full-screen overlay (⌘K) listing every agent session
/// across open repos, sorted by whether it needs the user. It's a triage
/// view, not a place to work: pick a card and you land in that worktree's
/// diff (⏎) or agent tab (t). The one inline action is answering a Claude
/// permission prompt, where switching worktrees would be pure friction.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, LayoutGrid, Loader2 } from "lucide-react";
import {
  agentRespondPermission,
  listAgentActivity,
  listAgentOverview,
} from "@/ipc/client";
import type {
  AgentActivity,
  AgentOverview,
  AgentSessionId,
  WorktreeActivity,
  WorktreeId,
} from "@/ipc/types";
import { cn } from "@/lib/cn";
import { asMessage } from "@/lib/errors";
import { commentStatus, useCommentsStore } from "@/stores/comments";
import { useDiffsStore } from "@/stores/diffs";
import { toastError } from "@/stores/toasts";
import { useUiStore } from "@/stores/ui";
import { useActivityStore } from "@/stores/activity";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import {
  BOARD_COLUMNS,
  boardOrder,
  columnOf,
  fallbackLabels,
  formatAge,
  groupBoard,
  summaryOf,
  type BoardColumn,
} from "./agent-board-model";

const POLL_MS = 1000;

/// Everything a card renders beyond the overview itself.
type CardContext = {
  branch: string;
  isMainClone: boolean;
  repo: string | null;
  label: string;
  status: WorktreeActivity | undefined;
  pendingComments: number;
};

/// Title-bar button for the board, beside the scratch pill. Turns amber
/// with a count when any worktree's agent needs you and the board is
/// closed.
export function AgentBoardPill() {
  const open = useUiStore((s) => s.agentBoardOpen);
  const toggle = useUiStore((s) => s.toggleAgentBoard);
  const needsYou = useActivityStore(
    (s) =>
      Object.values(s.byWorktree).filter(
        (w) => w.activity === "needsAttention",
      ).length,
  );
  const alert = needsYou > 0 && !open;
  return (
    <button
      onClick={toggle}
      title="Agent board (⌘K)"
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px]",
        alert
          ? "border-amber-500/60 text-amber-400"
          : open
            ? "border-neutral-600 bg-neutral-800 text-neutral-200"
            : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800",
      )}
    >
      <LayoutGrid size={12} />
      {alert ? `${needsYou} need${needsYou === 1 ? "s" : ""} you` : "board"}
      <span className="font-mono text-[10px] text-neutral-500">⌘K</span>
    </button>
  );
}

export function AgentBoard() {
  const open = useUiStore((s) => s.agentBoardOpen);
  if (!open) return null;
  return <AgentBoardOverlay />;
}

function AgentBoardOverlay() {
  const close = useCallback(() => useUiStore.getState().setAgentBoardOpen(false), []);
  // Dismissing without picking an agent hands focus back to whatever had
  // it (usually a terminal or the editor).
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  const dismiss = useCallback(() => {
    close();
    returnFocus.current?.focus();
  }, [close]);
  const layout = useUiStore((s) => s.agentBoardLayout);
  const setLayout = useUiStore((s) => s.setAgentBoardLayout);
  const seenAt = useUiStore((s) => s.agentSeenAt);
  const publishedLabels = useUiStore((s) => s.agentLabelsBySessionId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const comments = useCommentsStore((s) => s.items);

  const [overviews, setOverviews] = useState<AgentOverview[] | null>(null);
  const [statuses, setStatuses] = useState<Record<WorktreeId, WorktreeActivity>>({});
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<AgentSessionId | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const workspaceIdsKey = workspaces.map((w) => w.id).join(",");
  const refresh = useCallback(async () => {
    const ids = useWorkspaceStore.getState().workspaces.map((w) => w.id);
    try {
      const [rows, ...acts] = await Promise.all([
        listAgentOverview(ids),
        ...ids.map((id) => listAgentActivity(id)),
      ]);
      const map: Record<WorktreeId, WorktreeActivity> = {};
      for (const list of acts) for (const a of list) map[a.worktreeId] = a;
      setOverviews(rows);
      setStatuses(map);
      setNow(Date.now());
    } catch {
      // Transient (e.g. a workspace closing mid-poll); the next tick retries.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const handle = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(handle);
  }, [refresh, workspaceIdsKey]);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const worktreeById = useMemo(
    () => new Map(worktrees.map((w) => [w.id, w])),
    [worktrees],
  );
  const showRepo = workspaces.length > 1;

  const contexts = useMemo(() => {
    const fallback = fallbackLabels(overviews ?? []);
    const out = new Map<AgentSessionId, CardContext>();
    for (const o of overviews ?? []) {
      const wt = worktreeById.get(o.session.worktreeId);
      if (!wt) continue;
      const ws = workspaces.find((w) => w.id === wt.workspaceId);
      out.set(o.session.id, {
        branch: wt.branch,
        isMainClone: wt.isMainClone,
        repo: showRepo && ws ? basename(ws.root) : null,
        label: publishedLabels[o.session.id] ?? fallback[o.session.id],
        status: statuses[wt.id],
        pendingComments: ws
          ? comments.filter(
              (c) =>
                commentStatus(c) === "pending" &&
                c.workspaceRoot === ws.root &&
                c.branch === wt.branch,
            ).length
          : 0,
      });
    }
    return out;
  }, [overviews, worktreeById, workspaces, showRepo, publishedLabels, statuses, comments]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (overviews ?? []).filter((o) => {
      const ctx = contexts.get(o.session.id);
      if (!ctx) return false;
      if (!q) return true;
      return [ctx.branch, ctx.repo ?? "", ctx.label].some((s) =>
        s.toLowerCase().includes(q),
      );
    });
  }, [overviews, contexts, filter]);

  const grouped = useMemo(() => groupBoard(visible, seenAt), [visible, seenAt]);
  const order = useMemo(() => boardOrder(grouped), [grouped]);

  // Keep a valid selection as cards move between columns and come and go.
  useEffect(() => {
    if (order.length === 0) {
      if (selectedId !== null) setSelectedId(null);
    } else if (!order.some((o) => o.session.id === selectedId)) {
      setSelectedId(order[0].session.id);
    }
  }, [order, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    rootRef.current
      ?.querySelector(`[data-agent="${selectedId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId, layout]);

  const selected = order.find((o) => o.session.id === selectedId) ?? null;

  const openAgent = useCallback(
    (o: AgentOverview) => {
      useUiStore.getState().focusAgent(o.session.worktreeId, o.session.id);
      close();
    },
    [close],
  );

  const openDiff = useCallback(
    async (o: AgentOverview) => {
      const wt = o.session.worktreeId;
      const ui = useUiStore.getState();
      ui.focusAgent(wt, o.session.id);
      ui.setDiffSidebarTab("changes");
      close();
      const ds = useDiffsStore.getState();
      if (!ds.byWorktree[wt]) await ds.fetch(wt);
      const after = useDiffsStore.getState();
      const files = after.byWorktree[wt]?.files ?? [];
      if (files.length === 0) return;
      const current = after.selectedFile[wt];
      if (!current || !files.some((f) => f.path === current)) {
        after.selectFile(wt, files[0].path, "branch");
      }
      after.setView(wt, "diff");
    },
    [close],
  );

  const respond = useCallback(
    async (o: AgentOverview, allow: boolean) => {
      if (!o.canAnswerInline) return;
      try {
        await agentRespondPermission(o.session.id, allow);
      } catch (e) {
        toastError("Couldn't answer the prompt", asMessage(e));
      }
      void refresh();
    },
    [refresh],
  );

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.target === filterRef.current) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (filter) setFilter("");
        else rootRef.current?.focus();
      } else if (e.key === "Enter" || e.key === "ArrowDown") {
        e.preventDefault();
        rootRef.current?.focus();
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const i = order.findIndex((o) => o.session.id === selectedId);
    const move = (to: number) => {
      const next = order[Math.max(0, Math.min(order.length - 1, to))];
      if (next) setSelectedId(next.session.id);
    };
    const handled = (() => {
      switch (e.key) {
        case "j":
        case "ArrowDown":
          move(i + 1);
          return true;
        case "k":
        case "ArrowUp":
          move(i - 1);
          return true;
        case "Enter":
          if (selected) void openDiff(selected);
          return true;
        case "t":
          if (selected) openAgent(selected);
          return true;
        case "a":
          if (selected) void respond(selected, true);
          return true;
        case "d":
          if (selected) void respond(selected, false);
          return true;
        case "x":
          if (selected) useUiStore.getState().markAgentSeen(selected.session.id);
          return true;
        case "v":
          setLayout(layout === "board" ? "list" : "board");
          return true;
        case "/":
          filterRef.current?.focus();
          return true;
        case "Escape":
          dismiss();
          return true;
        default:
          return false;
      }
    })();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  const counts = {
    blocked: grouped.blocked.length,
    review: grouped.review.length,
    working: grouped.working.length,
  };

  const renderCard = (o: AgentOverview) => (
    <AgentCard
      key={o.session.id}
      o={o}
      ctx={contexts.get(o.session.id)!}
      column={columnOf(o, seenAt)}
      now={now}
      selected={o.session.id === selectedId}
      dense={layout === "list"}
      onSelect={() => setSelectedId(o.session.id)}
      onOpenDiff={() => void openDiff(o)}
      onOpenAgent={() => openAgent(o)}
      onRespond={(allow) => void respond(o, allow)}
    />
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-6 pt-[6vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        ref={rootRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Agent board"
        onKeyDown={onKeyDown}
        className="flex max-h-[86vh] w-full max-w-[1280px] flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl outline-none"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-800 px-4 py-2.5">
          <span className="text-sm font-semibold text-neutral-100">Agents</span>
          <div className="flex gap-3 text-xs tabular-nums text-neutral-500">
            <span>
              <b className="font-semibold text-amber-400">{counts.blocked}</b> need you
            </span>
            <span>
              <b className="font-semibold text-emerald-400">{counts.review}</b> to review
            </span>
            <span>
              <b className="font-semibold text-sky-400">{counts.working}</b> working
            </span>
          </div>
          <div className="flex-1" />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter branch, repo, or agent  /"
            className="w-56 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-blue-600 focus:outline-none"
          />
          <div className="flex overflow-hidden rounded border border-neutral-700 text-xs">
            {(["board", "list"] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLayout(l)}
                className={cn(
                  "px-2.5 py-1 capitalize",
                  layout === l
                    ? "bg-blue-900/40 text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-300",
                )}
              >
                {l}
              </button>
            ))}
          </div>
          <button
            onClick={dismiss}
            title="Close (Esc)"
            className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            Esc
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {overviews === null ? (
            <div className="p-6 text-center text-xs text-neutral-600">Loading agents…</div>
          ) : overviews.length === 0 ? (
            <div className="p-10 text-center text-xs text-neutral-500">
              No agents are running. Open a worktree and press{" "}
              <Kbd>⌘⇧A</Kbd> to start one.
            </div>
          ) : visible.length === 0 ? (
            <div className="p-10 text-center text-xs text-neutral-500">
              No agents match “{filter}”.
            </div>
          ) : layout === "board" ? (
            <div className="grid grid-cols-1 gap-x-3 md:grid-cols-2 xl:grid-cols-4">
              {BOARD_COLUMNS.map((c) => (
                <section key={c.key} className="flex min-w-0 flex-col gap-2">
                  <div className="sticky top-0 z-10 bg-neutral-900 pb-1 pt-3">
                    <ColumnHeader column={c.key} label={c.label} count={grouped[c.key].length} />
                  </div>
                  {grouped[c.key].length === 0 ? (
                    <div className="rounded border border-dashed border-neutral-800 px-3 py-2 text-xs text-neutral-600">
                      Nothing here
                    </div>
                  ) : (
                    grouped[c.key].map(renderCard)
                  )}
                </section>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {BOARD_COLUMNS.filter((c) => grouped[c.key].length > 0).map((c) => (
                <section key={c.key} className="flex flex-col gap-1">
                  <div className="sticky top-0 z-10 bg-neutral-900 px-1 pb-1 pt-3">
                    <ColumnHeader column={c.key} label={c.label} count={grouped[c.key].length} />
                  </div>
                  {grouped[c.key].map(renderCard)}
                </section>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-neutral-800 px-4 py-1.5 text-[11px] text-neutral-500">
          <span><Kbd>j</Kbd> <Kbd>k</Kbd> move</span>
          <span><Kbd>⏎</Kbd> open diff</span>
          <span><Kbd>t</Kbd> open agent</span>
          <span><Kbd>a</Kbd> allow</span>
          <span><Kbd>d</Kbd> deny</span>
          <span><Kbd>x</Kbd> mark seen</span>
          <span><Kbd>v</Kbd> board / list</span>
          <span><Kbd>/</Kbd> filter</span>
        </div>
      </div>
    </div>
  );
}

function ColumnHeader({
  column,
  label,
  count,
}: {
  column: BoardColumn;
  label: string;
  count: number;
}) {
  return (
    <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
      <ColumnGlyph column={column} />
      {label}
      <span className="tabular-nums text-neutral-600">{count}</span>
    </h3>
  );
}

function ColumnGlyph({ column }: { column: BoardColumn }) {
  const activity: AgentActivity =
    column === "blocked"
      ? "needsAttention"
      : column === "working"
        ? "working"
        : column === "review"
          ? "idle"
          : "inactive";
  return <Glyph activity={activity} />;
}

/// Same vocabulary as the sidebar's status dot.
function Glyph({ activity }: { activity: AgentActivity }) {
  const wrap = "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center";
  switch (activity) {
    case "working":
      return (
        <span className={wrap}>
          <Loader2 size={12} className="animate-spin text-sky-400 motion-reduce:animate-none" />
        </span>
      );
    case "idle":
      return (
        <span className={wrap}>
          <Check size={12} className="text-emerald-400" />
        </span>
      );
    case "needsAttention":
      return (
        <span className={wrap}>
          <AlertTriangle size={12} className="animate-pulse text-amber-400 motion-reduce:animate-none" />
        </span>
      );
    default:
      return (
        <span className={wrap}>
          <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
        </span>
      );
  }
}

function AgentCard({
  o,
  ctx,
  column,
  now,
  selected,
  dense,
  onSelect,
  onOpenDiff,
  onOpenAgent,
  onRespond,
}: {
  o: AgentOverview;
  ctx: CardContext;
  column: BoardColumn;
  now: number;
  selected: boolean;
  dense: boolean;
  onSelect: () => void;
  onOpenDiff: () => void;
  onOpenAgent: () => void;
  onRespond: (allow: boolean) => void;
}) {
  const summary = summaryOf(o);
  const stats = o.diffStats;
  const blocked = column === "blocked";
  const age = formatAge(o.changedAt, now);
  return (
    <div
      data-agent={o.session.id}
      onClick={() => (selected ? onOpenDiff() : onSelect())}
      onDoubleClick={onOpenDiff}
      title={selected ? "Click to open the diff" : undefined}
      className={cn(
        // scroll-mt clears the sticky column header when j/k scrolls a card into view.
        "flex min-w-0 scroll-mt-10 cursor-pointer flex-col gap-1.5 rounded-md border px-2.5 py-2 text-xs transition-colors",
        blocked
          ? "border-amber-500/30 bg-amber-500/[0.06] hover:bg-amber-500/10"
          : "border-neutral-800 bg-neutral-950/60 hover:bg-neutral-800/60",
        selected && "border-blue-500 ring-1 ring-inset ring-blue-500",
        dense && "gap-1 py-1.5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Glyph activity={o.activity} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-[12px] text-neutral-100">
            {ctx.branch}
            {ctx.isMainClone && (
              <span className="ml-1.5 rounded border border-blue-800/60 px-1 font-sans text-[10px] text-blue-300">
                main clone
              </span>
            )}
          </span>
          <span className="truncate text-[11px] text-neutral-500">
            {ctx.repo && (
              <span className="mr-1.5 rounded border border-neutral-700 px-1 font-mono text-[10px] text-neutral-400">
                {ctx.repo}
              </span>
            )}
            {ctx.label}
          </span>
        </div>
        <span className="shrink-0 self-start tabular-nums text-[11px] text-neutral-600">
          {age}
        </span>
      </div>

      {summary && (
        <div
          className={cn(
            "whitespace-pre-line break-words text-neutral-300",
            dense ? "line-clamp-1" : "line-clamp-3",
          )}
        >
          {summary}
        </div>
      )}

      <Meta stats={stats} ctx={ctx} />

      {blocked && o.pending?.kind === "permission" && (
        <div className="flex flex-col gap-1.5 border-t border-amber-500/20 pt-1.5">
          <div className="text-neutral-200">
            Allow <span className="font-semibold">{o.pending.toolName}</span>?
          </div>
          {o.pending.detail && (
            <code className="line-clamp-3 whitespace-pre-wrap break-all rounded bg-black/40 px-1.5 py-1 font-mono text-[11px] text-neutral-200">
              {o.pending.detail}
            </code>
          )}
          <div className="flex gap-1.5">
            {o.canAnswerInline ? (
              <>
                <ActionButton primary onClick={() => onRespond(true)} kbd="a">
                  Allow
                </ActionButton>
                <ActionButton onClick={() => onRespond(false)} kbd="d">
                  Deny
                </ActionButton>
              </>
            ) : (
              <ActionButton onClick={onOpenAgent} kbd="t">
                Answer in agent
              </ActionButton>
            )}
          </div>
        </div>
      )}
      {blocked && o.pending?.kind !== "permission" && (
        <div className="flex gap-1.5 border-t border-amber-500/20 pt-1.5">
          <ActionButton primary onClick={onOpenAgent} kbd="t">
            Reply in agent
          </ActionButton>
        </div>
      )}
    </div>
  );
}

function Meta({
  stats,
  ctx,
}: {
  stats: AgentOverview["diffStats"];
  ctx: CardContext;
}) {
  const ahead = ctx.status?.ahead ?? 0;
  const behind = ctx.status?.behind ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] tabular-nums text-neutral-500">
      {stats && stats.filesChanged > 0 ? (
        <>
          <span>
            <span className="text-emerald-400">+{stats.insertions}</span>{" "}
            <span className="text-red-400">−{stats.deletions}</span>
          </span>
          <DiffBar insertions={stats.insertions} deletions={stats.deletions} />
          <span>
            {stats.filesChanged} {stats.filesChanged === 1 ? "file" : "files"}
          </span>
        </>
      ) : (
        <span>no changes</span>
      )}
      {ctx.pendingComments > 0 && (
        <Chip className="border-blue-700/60 text-blue-300">
          {ctx.pendingComments} pending {ctx.pendingComments === 1 ? "comment" : "comments"}
        </Chip>
      )}
      {behind > 0 && (
        <Chip className="border-amber-600/50 text-amber-400">↓{behind} behind</Chip>
      )}
      {ahead > 0 && <Chip>↑{ahead}</Chip>}
    </div>
  );
}

/// Proportion bar whose width grows with log(size), so a 5-line fix and
/// a 1,300-line migration read differently at a glance.
function DiffBar({ insertions, deletions }: { insertions: number; deletions: number }) {
  const total = insertions + deletions;
  if (total === 0) return null;
  const width = Math.min(40, Math.max(8, Math.round(Math.log10(total + 1) * 12)));
  return (
    <span
      className="inline-flex h-1.5 overflow-hidden rounded-sm bg-neutral-800"
      style={{ width }}
    >
      <span className="h-full bg-emerald-500" style={{ width: `${(insertions / total) * 100}%` }} />
      <span className="h-full bg-red-500" style={{ width: `${(deletions / total) * 100}%` }} />
    </span>
  );
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "rounded-full border border-neutral-700 px-1.5 font-sans text-[10.5px] text-neutral-400",
        className,
      )}
    >
      {children}
    </span>
  );
}

function ActionButton({
  children,
  onClick,
  kbd,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  kbd: string;
  primary?: boolean;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs",
        primary
          ? "border-blue-600 bg-blue-600 text-white hover:bg-blue-500"
          : "border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800",
      )}
    >
      {children}
      <span className="rounded border border-current px-1 font-mono text-[10px] opacity-60">
        {kbd}
      </span>
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-b-2 border-neutral-700 bg-neutral-950 px-1 font-mono text-[10.5px] text-neutral-400">
      {children}
    </kbd>
  );
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
