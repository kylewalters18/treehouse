/// Per-worktree status beyond the agent dot: the terminal-command line
/// under a sidebar row and the hover card
/// with everything running in the worktree.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, X } from "lucide-react";
import { getWorktreeDetails, getWorktreeDiskUsage } from "@/ipc/client";
import type {
  AgentActivity,
  DiskUsage,
  TerminalCommand,
  Worktree,
  WorktreeActivity,
  WorktreeDetails,
} from "@/ipc/types";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/time";
import {
  commandLabel,
  formatElapsed,
  isRunning,
  type RowCommand,
} from "@/lib/terminal-command";

/// `Date.now()`, re-rendering every second while `active`.
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return active ? now : Date.now();
}

export function CommandIcon({ command, size = 10 }: { command: TerminalCommand; size?: number }) {
  if (isRunning(command)) {
    return <Loader2 size={size} className="shrink-0 animate-spin text-blue-400" />;
  }
  if (command.exitCode != null && command.exitCode !== 0) {
    return <X size={size} strokeWidth={2.5} className="shrink-0 text-rose-400" />;
  }
  return <Check size={size} strokeWidth={2.5} className="shrink-0 text-emerald-400" />;
}

/// "3:12" while running; "exit 1 · 2m ago" / "2m ago" once finished.
function commandTiming(c: TerminalCommand, now: number): string {
  if (c.finishedAt == null) return formatElapsed(now - c.startedAt);
  const ago = relativeTime(c.finishedAt);
  return c.exitCode != null && c.exitCode !== 0 ? `exit ${c.exitCode} · ${ago}` : ago;
}

/// Second line of a worktree row: the terminal command. Only the command
/// label truncates; timing and counts keep their place.
export function RowStatusLine({
  row,
  now,
}: {
  row: RowCommand | null;
  now: number;
}) {
  const c = row?.command;
  const failed = c?.finishedAt != null && c.exitCode != null && c.exitCode !== 0;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] leading-4 text-neutral-500">
      {c && (
        <>
          <CommandIcon command={c} />
          <span
            className={cn(
              "min-w-0 truncate font-mono",
              isRunning(c) ? "text-blue-300" : failed ? "text-rose-300" : "text-neutral-400",
            )}
            title={c.command}
          >
            {commandLabel(c.command) || "command"}
          </span>
          <span className="shrink-0 font-mono">{commandTiming(c, now)}</span>
          {row.othersRunning > 0 && (
            <span className="shrink-0 font-mono" title={`${row.othersRunning} more running`}>
              +{row.othersRunning}
            </span>
          )}
        </>
      )}
    </span>
  );
}

const HOVER_DELAY_MS = 500;

type HoverTarget = { worktree: Worktree; row: HTMLElement; rect: DOMRect };

/// Hover-intent for sidebar rows: `bind(w)` goes on the row, `target` is
/// the row whose card should show. A click, scrolling the row's list, or
/// `close()` hides it.
export function useWorktreeHover() {
  const [target, setTarget] = useState<HoverTarget | null>(null);
  const timer = useRef<number | null>(null);

  const close = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    setTarget(null);
  }, []);

  useEffect(() => {
    if (!target) return;
    // Only a scroll that moves the row: a terminal streaming output scrolls
    // its own viewport constantly and must not dismiss the card.
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && e.target.contains(target.row)) close();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("mousedown", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("resize", close);
    };
  }, [target, close]);

  useEffect(() => close, [close]);

  const bind = (worktree: Worktree) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget;
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        // Not while the row's ⋯ menu is open.
        if (el.querySelector("[data-open]")) return;
        setTarget({ worktree, row: el, rect: el.getBoundingClientRect() });
      }, HOVER_DELAY_MS);
    },
    onMouseLeave: close,
  });

  return { target, bind, close };
}

const DETAILS_REFRESH_MS = 3_000;

const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  inactive: "not running",
  working: "working",
  idle: "idle",
  needsAttention: "needs you",
  untracked: "running",
};

function formatBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
      {children}
    </div>
  );
}

/// Detail card beside a hovered row: terminals and their ports, agents and
/// language servers, uncommitted files, disk and process usage. Fetched
/// when it opens and refreshed while it stays open.
export function WorktreeHoverCard({
  target,
  activity,
}: {
  target: HoverTarget;
  activity: WorktreeActivity | undefined;
}) {
  const { worktree, rect } = target;
  const [details, setDetails] = useState<WorktreeDetails | null>(null);
  const [disk, setDisk] = useState<DiskUsage | null>(null);
  const [top, setTop] = useState(rect.top);
  const ref = useRef<HTMLDivElement>(null);
  const hasRunning = (activity?.commands ?? []).some(isRunning);
  const now = useNow(hasRunning);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getWorktreeDetails(worktree.id)
        .then((d) => alive && setDetails(d))
        .catch(() => {});
    load();
    const t = window.setInterval(load, DETAILS_REFRESH_MS);
    getWorktreeDiskUsage(worktree.id)
      .then((d) => alive && setDisk(d))
      .catch(() => {});
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [worktree.id]);

  // Keep the card inside the window as its content loads.
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(rect.top - 8, window.innerHeight - h - 8)));
  }, [rect.top, details, disk]);

  // Live command state comes from the activity push; the details fetch
  // supplies terminals without a command and the ports.
  const liveCommands = new Map(
    (activity?.commands ?? []).map((c) => [c.terminalId, c]),
  );
  const agentCount = activity?.agentCount ?? 0;
  const otherPorts = details
    ? details.ports.filter((p) => !details.terminals.some((t) => t.ports.includes(p)))
    : [];

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{ top, left: rect.right + 6 }}
      className="pointer-events-none fixed z-50 w-80 rounded-md border border-neutral-800 bg-neutral-900 text-xs text-neutral-300 shadow-xl shadow-black/50"
    >
      <div className="border-b border-neutral-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-neutral-100">
            {worktree.branch}
          </span>
          {(activity?.ahead ?? 0) > 0 && (
            <span className="font-mono text-[11px] text-emerald-400">↑{activity?.ahead}</span>
          )}
          {(activity?.behind ?? 0) > 0 && (
            <span className="font-mono text-[11px] text-amber-400">↓{activity?.behind}</span>
          )}
        </div>
        <div className="truncate font-mono text-[10.5px] text-neutral-500">
          {worktree.path}
        </div>
      </div>

      <div className="border-b border-neutral-800 px-3 py-2">
        <SectionTitle>Terminals</SectionTitle>
        {!details ? (
          <div className="text-neutral-500">…</div>
        ) : details.terminals.length === 0 ? (
          <div className="text-neutral-500">None open</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {details.terminals.map((t) => {
              const c = liveCommands.get(t.terminalId) ?? t.command;
              return (
                <li key={t.terminalId} className="flex min-w-0 items-center gap-2">
                  {c ? (
                    <CommandIcon command={c} size={11} />
                  ) : (
                    <span className="w-[11px] shrink-0 text-center text-neutral-600">–</span>
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate font-mono",
                      c && isRunning(c) ? "text-blue-300" : "text-neutral-300",
                    )}
                    title={c?.command}
                  >
                    {c ? c.command : "idle"}
                  </span>
                  {t.ports.map((p) => (
                    <span key={p} className="shrink-0 font-mono text-neutral-300">
                      :{p}
                    </span>
                  ))}
                  {c && (
                    <span className="shrink-0 font-mono text-neutral-500">
                      {commandTiming(c, now)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-b border-neutral-800 px-3 py-2">
        <SectionTitle>Agents · Language servers</SectionTitle>
        <div className="flex items-center gap-2">
          <span className="flex-1 text-neutral-300">
            {agentCount === 0
              ? "No agents"
              : `${agentCount} ${agentCount === 1 ? "agent" : "agents"} · ${ACTIVITY_LABEL[activity?.activity ?? "inactive"]}`}
          </span>
          <span className="truncate text-neutral-500">
            {details?.lspServers.length ? details.lspServers.join(", ") : "no LSP"}
          </span>
        </div>
      </div>

      <div className="border-b border-neutral-800 px-3 py-2">
        <SectionTitle>
          Uncommitted{details ? ` · ${details.changedTotal}` : ""}
        </SectionTitle>
        {!details ? (
          <div className="text-neutral-500">…</div>
        ) : details.changedTotal === 0 ? (
          <div className="text-neutral-500">Clean</div>
        ) : (
          <ul className="flex flex-col font-mono text-[11px]">
            {details.changedFiles.slice(0, 8).map((f) => (
              <li key={f.path} className="flex min-w-0 gap-2">
                <span
                  className={cn(
                    "w-4 shrink-0",
                    f.status === "??" || f.status === "A"
                      ? "text-emerald-400"
                      : f.status === "D"
                        ? "text-rose-400"
                        : "text-amber-400",
                  )}
                >
                  {f.status === "??" ? "U" : f.status}
                </span>
                <span className="min-w-0 truncate text-neutral-300">
                  {f.path}
                </span>
              </li>
            ))}
            {details.changedTotal > 8 && (
              <li className="text-neutral-500">+{details.changedTotal - 8} more</li>
            )}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 px-3 py-2">
        <div className="min-w-0">
          <SectionTitle>Disk</SectionTitle>
          {!disk ? (
            <div className="text-neutral-500">measuring…</div>
          ) : (
            <>
              <div className="font-mono text-neutral-200">{formatBytes(disk.totalBytes)}</div>
              {disk.largest
                .filter((e) => e.bytes >= disk.totalBytes * 0.1 && e.bytes >= 50 * 1024 ** 2)
                .slice(0, 3)
                .map((e) => (
                  <div key={e.name} className="truncate font-mono text-[10.5px] text-neutral-500">
                    {e.name} {formatBytes(e.bytes)}
                  </div>
                ))}
            </>
          )}
        </div>
        <div className="min-w-0">
          <SectionTitle>Processes</SectionTitle>
          {!details ? (
            <div className="text-neutral-500">…</div>
          ) : !details.processes ? (
            <div className="text-neutral-500">unavailable</div>
          ) : (
            <>
              <div className="font-mono text-neutral-200">
                {Math.round(details.processes.cpuPercent)}% CPU
              </div>
              <div className="font-mono text-[10.5px] text-neutral-500">
                {formatBytes(details.processes.rssBytes)} · {details.processes.count} procs
              </div>
              {otherPorts.length > 0 && (
                <div className="truncate font-mono text-[10.5px] text-neutral-500">
                  {otherPorts.map((p) => `:${p}`).join(" ")}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
