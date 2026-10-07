import { useEffect, useMemo, useRef, useState } from "react";
import type { ForgeJob, ForgeJobLog, ForgePipeline } from "@/ipc/types";
import { forgeJobLog, openExternalUrl } from "@/ipc/client";
import { useForgeStore, forgeBranchKey } from "@/stores/forge";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { workspaceForWorktree } from "@/stores/workspace";
import { pasteAndSubmit } from "@/lib/agent";
import { latestJobsPerName } from "@/lib/forge-jobs";
import { ciStatusVisual } from "@/lib/ci-status";
import {
  agentPrompt,
  ansiLines,
  defaultJob,
  defaultSection,
  formatDuration,
  jobDurationSecs,
  pipelineSpanSecs,
} from "@/lib/ci-log";
import { relativeTime } from "@/lib/time";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import { asMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";

const TERMINAL_STATES = ["success", "failed", "canceled", "skipped", "manual"];
/// Job states with no log yet.
const NOT_STARTED = [
  "created",
  "pending",
  "manual",
  "skipped",
  "scheduled",
  "waiting_for_resource",
  "preparing",
];
/// Runs shown in the history strip.
const HISTORY = 10;
/// Lines rendered per section before "show earlier lines".
const SECTION_LINE_CAP = 4000;

/// CI panel for the selected worktree's branch: a pipeline summary, recent
/// runs, and the job list on the left; the selected job's log — split into
/// the forge's sections, searchable, followable while running — on the
/// right. Polls while the shown pipeline is active.
export function CIPanel() {
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const selected = worktrees.find((w) => w.id === selectedWorktreeId) ?? null;
  const workspace = workspaceForWorktree(selected?.workspaceId);
  const activeAgentId = useUiStore((s) =>
    selectedWorktreeId ? s.activeAgentByWorktree[selectedWorktreeId] ?? null : null,
  );
  const wsId = workspace?.id ?? null;
  const branch = selected?.branch ?? null;

  const pipelines = useForgeStore((s) =>
    wsId && branch ? s.pipelinesByBranch[forgeBranchKey(wsId, branch)] : undefined,
  );
  const loadPipelines = useForgeStore((s) => s.loadPipelines);
  const loadJobs = useForgeStore((s) => s.loadJobs);
  const retryPipeline = useForgeStore((s) => s.retryPipeline);
  const retryJob = useForgeStore((s) => s.retryJob);

  // Which run is shown: the latest unless one was picked from the history
  // strip (on this branch).
  const [picked, setPicked] = useState<{ branch: string; id: number } | null>(null);
  const pipeline: ForgePipeline | undefined =
    (picked?.branch === branch && pipelines?.find((p) => p.id === picked.id)) ||
    pipelines?.[0];
  const allJobs = useForgeStore((s) => (pipeline ? s.jobsByPipeline[pipeline.id] : undefined));

  // Stages in execution order (earliest job id seen per stage, retries
  // included — a retry's higher id would otherwise drag its stage), each
  // with the latest run of its jobs.
  const stages = useMemo(() => {
    const jobs = allJobs ?? [];
    const minId = new Map<string, number>();
    for (const j of jobs) {
      const st = j.stage || "jobs";
      minId.set(st, Math.min(minId.get(st) ?? Infinity, j.id));
    }
    const byStage = new Map<string, ForgeJob[]>();
    for (const j of latestJobsPerName(jobs)) {
      const st = j.stage || "jobs";
      if (!byStage.has(st)) byStage.set(st, []);
      byStage.get(st)!.push(j);
    }
    return [...byStage.keys()]
      .sort((a, b) => (minId.get(a) ?? 0) - (minId.get(b) ?? 0))
      .map((name) => ({ name, jobs: byStage.get(name)!.sort((a, b) => a.id - b.id) }));
  }, [allJobs]);
  const ordered = useMemo(() => stages.flatMap((s) => s.jobs), [stages]);

  // Selected job: kept across polls by name, so a retry (new id) stays
  // selected.
  const [jobKey, setJobKey] = useState<string | null>(null);
  const job =
    ordered.find((j) => `${j.stage} ${j.name}` === jobKey) ?? defaultJob(ordered) ?? null;

  useEffect(() => {
    if (wsId && branch) void loadPipelines(wsId, branch);
  }, [wsId, branch, loadPipelines]);

  useEffect(() => {
    if (wsId && pipeline) void loadJobs(wsId, pipeline.id);
  }, [wsId, pipeline?.id, loadJobs]); // eslint-disable-line react-hooks/exhaustive-deps

  // A different run or branch starts from its default job.
  useEffect(() => setJobKey(null), [pipeline?.id, branch]);

  const active = !!pipeline && !TERMINAL_STATES.includes(pipeline.status);
  useEffect(() => {
    if (!active || !wsId || !branch || !pipeline) return;
    const id = pipeline.id;
    const t = window.setInterval(() => {
      void loadPipelines(wsId, branch);
      void loadJobs(wsId, id);
    }, 5000);
    return () => window.clearInterval(t);
  }, [active, wsId, branch, pipeline?.id, loadPipelines, loadJobs]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!selected) return <Empty>Select a worktree to see its pipelines.</Empty>;
  if (!pipelines) return <Empty>Loading pipelines…</Empty>;
  if (!pipeline) return <Empty>No pipelines for {selected.branch}.</Empty>;

  const history = pipelines.slice(0, HISTORY).reverse();
  const span = allJobs ? pipelineSpanSecs(latestJobsPerName(allJobs)) : null;
  const isHead = !selected.head || pipeline.sha.startsWith(selected.head) || selected.head.startsWith(pipeline.sha);
  const v = ciStatusVisual(pipeline.status);

  return (
    <div className="flex h-full min-h-0 bg-neutral-950 text-[13px] text-neutral-300">
      {/* Left: summary, history, jobs */}
      <div className="flex w-[300px] shrink-0 flex-col border-r border-neutral-800/70">
        <div className="flex flex-col gap-1.5 border-b border-neutral-900 px-3 pb-2 pt-2.5">
          <div className="flex items-center gap-2">
            <StatusDot status={pipeline.status} />
            <span className={cn("font-medium capitalize", statusText(pipeline.status))}>
              {v.label}
            </span>
            <span className="truncate font-mono text-[11px] text-neutral-500">
              #{pipeline.id}
              {span !== null && ` · ${formatDuration(span)}`}
            </span>
            <span className="flex-1" />
            <div className="flex items-center gap-[3px]">
              {history.map((p) => (
                <button
                  key={p.id}
                  onClick={() => branch && setPicked({ branch, id: p.id })}
                  title={`#${p.id} · ${ciStatusVisual(p.status).label}${p.title ? ` · ${p.title}` : ""}`}
                  aria-label={`Show pipeline ${p.id}`}
                  className={cn(
                    "h-3.5 w-1.5 rounded-[2px]",
                    pipColor(p.status),
                    p.id === pipeline.id
                      ? "outline outline-[1.5px] outline-offset-1 outline-neutral-200"
                      : "opacity-70 hover:opacity-100",
                  )}
                />
              ))}
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="font-mono text-[11px] text-neutral-400">{pipeline.sha.slice(0, 7)}</span>
            <span className="truncate text-neutral-400" title={pipeline.title ?? undefined}>
              {pipeline.title ?? ""}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-neutral-500">
            {pipeline.createdAt && <span>{relativeTime(Date.parse(pipeline.createdAt))}</span>}
            {!isHead && (
              <span
                className="rounded border border-amber-900/70 bg-amber-950/30 px-1.5 text-amber-300"
                title="This run is for an older commit than the worktree's HEAD — push to run CI on it"
              >
                not HEAD
              </span>
            )}
            <span className="flex-1" />
            <button
              onClick={() => wsId && branch && void retryPipeline(wsId, branch, pipeline.id)}
              className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              title="Retry the failed jobs in this pipeline"
            >
              Retry
            </button>
            <IconButton
              label="Open pipeline in browser"
              onClick={() => void openExternalUrl(pipeline.webUrl)}
            >
              <ExternalIcon />
            </IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
          {!allJobs && <div className="px-2 py-2 text-xs text-neutral-600">Loading jobs…</div>}
          {stages.map((stage) => (
            <div key={stage.name}>
              <div className="flex items-center gap-1.5 px-1.5 pb-0.5 pt-1.5">
                <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-600">
                  {stage.name}
                </span>
                <span className="h-px flex-1 bg-neutral-900" />
              </div>
              {stage.jobs.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  selected={job?.id === j.id}
                  onSelect={() => setJobKey(`${j.stage} ${j.name}`)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Right: log viewer */}
      {job && wsId ? (
        <LogViewer
          key={job.id}
          wsId={wsId}
          job={job}
          activeAgentId={activeAgentId}
          onRetry={() => branch && void retryJob(wsId, branch, pipeline.id, job.id)}
        />
      ) : (
        <Empty>{allJobs ? "No jobs in this pipeline." : ""}</Empty>
      )}
    </div>
  );
}

function JobRow({
  job,
  selected,
  onSelect,
}: {
  job: ForgeJob;
  selected: boolean;
  onSelect: () => void;
}) {
  const dur = jobDurationSecs(job);
  const dim = job.status === "skipped" || (job.allowFailure && job.status === "failed");
  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-[5px] border px-2 text-left",
        selected
          ? job.status === "failed"
            ? "border-red-950 bg-red-950/30"
            : "border-neutral-800 bg-neutral-900"
          : "border-transparent hover:bg-neutral-900/60",
      )}
    >
      <StatusDot status={job.allowFailure && job.status === "failed" ? "warn" : job.status} />
      <span className={cn("truncate", dim ? "text-neutral-500" : "text-neutral-200")}>{job.name}</span>
      {job.attempt > 1 && (
        <span
          className="rounded-[3px] border border-neutral-700 px-1 font-mono text-[10px] text-neutral-400"
          title={`Attempt ${job.attempt}`}
        >
          #{job.attempt}
        </span>
      )}
      {job.allowFailure && job.status === "failed" && (
        <span className="shrink-0 text-[10.5px] text-neutral-500">allowed to fail</span>
      )}
      {job.status === "manual" && <span className="shrink-0 text-[10.5px] text-sky-400/80">manual</span>}
      <span className="flex-1" />
      <span className="shrink-0 font-mono text-[11px] text-neutral-500">
        {dur !== null ? formatDuration(dur) : job.status === "skipped" ? "—" : ""}
      </span>
    </button>
  );
}

/// One job's log: toolbar, then the forge's sections as collapsible groups.
/// Remounted per job (keyed by id), so its state starts fresh.
function LogViewer({
  wsId,
  job,
  activeAgentId,
  onRetry,
}: {
  wsId: string;
  job: ForgeJob;
  activeAgentId: string | null;
  onRetry: () => void;
}) {
  const running = job.status === "running";
  // A trace only exists once a job has started.
  const hasLog = !NOT_STARTED.includes(job.status);
  const retryable = ["failed", "success", "canceled"].includes(job.status);

  const [log, setLog] = useState<ForgeJobLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number> | null>(null);
  const [follow, setFollow] = useState(running);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Load, and keep reloading while the job runs.
  useEffect(() => {
    if (!hasLog) return;
    let cancelled = false;
    const load = () =>
      forgeJobLog(wsId, job.id).then(
        (l) => {
          if (cancelled) return;
          setLog(l);
          setError(null);
        },
        (e) => !cancelled && setError(asMessage(e)),
      );
    void load();
    if (!running) return () => void (cancelled = true);
    const t = window.setInterval(load, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [wsId, job.id, hasLog, running]);

  const focus = log ? defaultSection(log.sections, job.status) : -1;
  // Open the culprit section the first time the log arrives.
  useEffect(() => {
    if (log && open === null) setOpen(new Set(focus >= 0 ? [focus] : []));
  }, [log, open, focus]);

  const lines = useMemo(
    () => (log ? log.sections.map((s) => ansiLines(s.text)) : []),
    [log],
  );
  // Plain text per line for search, built lazily.
  const plain = useMemo(
    () => (query ? lines.map((sec) => sec.map((l) => l.map((s) => s.text).join("").toLowerCase())) : null),
    [lines, query],
  );
  const matches = useMemo(() => {
    if (!plain) return [];
    const q = query.toLowerCase();
    const out: { s: number; l: number }[] = [];
    plain.forEach((sec, s) => sec.forEach((t, l) => t.includes(q) && out.push({ s, l })));
    return out;
  }, [plain, query]);
  const matchSet = useMemo(() => new Set(matches.map((m) => `${m.s}:${m.l}`)), [matches]);
  const current = matches.length ? matches[Math.min(matchIdx, matches.length - 1)] : null;

  // Jump to the current match, opening its section.
  useEffect(() => {
    if (!current) return;
    setOpen((o) => (o?.has(current.s) ? o : new Set([...(o ?? []), current.s])));
    requestAnimationFrame(() =>
      scrollRef.current
        ?.querySelector(`[data-line="${current.s}:${current.l}"]`)
        ?.scrollIntoView({ block: "center" }),
    );
  }, [current?.s, current?.l]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow: stick to the bottom as output arrives.
  useEffect(() => {
    if (!follow || !log || !scrollRef.current) return;
    if (running) setOpen((o) => new Set([...(o ?? []), log.sections.length - 1]));
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [log, follow, running]);

  async function sendToAgent() {
    if (!activeAgentId) {
      toastInfo("No active agent in this worktree");
      return;
    }
    try {
      const l = log ?? (await forgeJobLog(wsId, job.id));
      const f = defaultSection(l.sections, job.status);
      await pasteAndSubmit(activeAgentId, agentPrompt(job, l.sections, f));
      toastSuccess(
        `Sent ${job.name} log to agent`,
        job.status === "failed" ? "Asked it to fix." : "Sent as context.",
      );
    } catch (e) {
      toastError("Couldn't send log", asMessage(e));
    }
  }

  function toggle(i: number) {
    setOpen((o) => {
      const next = new Set(o ?? []);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  const dur = jobDurationSecs(job);
  const meta = [
    job.stage,
    job.attempt > 1 ? `attempt ${job.attempt}` : null,
    dur !== null ? formatDuration(dur) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  let lineNo = 1;

  return (
    <div
      className="flex min-w-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.metaKey && e.key === "f") {
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        }
      }}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-800/70 px-3">
        <StatusDot status={job.status} />
        <span className="truncate font-medium text-neutral-200">{job.name}</span>
        <span className="shrink-0 text-[11px] text-neutral-500">{meta}</span>
        <span className="flex-1" />
        {hasLog && (
          <label className="flex h-[26px] w-48 items-center gap-1.5 rounded-[5px] border border-neutral-800 bg-neutral-900/60 px-2 text-neutral-500 focus-within:border-neutral-600">
            <SearchIcon />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMatchIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matches.length) {
                  setMatchIdx((i) => (i + (e.shiftKey ? matches.length - 1 : 1)) % matches.length);
                } else if (e.key === "Escape") {
                  setQuery("");
                }
              }}
              placeholder="Search log"
              aria-label="Search log"
              className="min-w-0 flex-1 bg-transparent text-xs text-neutral-200 outline-none placeholder:text-neutral-600"
            />
            {query && (
              <span className="shrink-0 font-mono text-[10px] text-neutral-500">
                {matches.length ? `${Math.min(matchIdx, matches.length - 1) + 1}/${matches.length}` : "0"}
              </span>
            )}
          </label>
        )}
        {running && (
          <button
            onClick={() => setFollow((f) => !f)}
            className={cn(
              "h-[26px] rounded-[5px] border px-2 text-xs",
              follow
                ? "border-neutral-600 bg-neutral-800 text-neutral-200"
                : "border-neutral-800 text-neutral-500 hover:text-neutral-300",
            )}
            title="Keep scrolled to the newest output"
          >
            Follow
          </button>
        )}
        {retryable && (
          <button
            onClick={onRetry}
            className="h-[26px] rounded-[5px] border border-neutral-700 bg-neutral-900 px-2 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Retry
          </button>
        )}
        {hasLog && (
          <button
            onClick={() => void sendToAgent()}
            className={cn(
              "h-[26px] rounded-[5px] border px-2.5 text-xs font-medium",
              job.status === "failed"
                ? "border-blue-700 bg-blue-950/40 text-blue-200 hover:bg-blue-950/60"
                : "border-neutral-700 text-neutral-300 hover:bg-neutral-800",
            )}
            title={
              job.status === "failed"
                ? "Send the failing step's log to the active agent and ask it to fix"
                : "Send this job's log to the active agent as context"
            }
          >
            Send to agent
          </button>
        )}
        {job.webUrl && (
          <IconButton label="Open job in browser" onClick={() => void openExternalUrl(job.webUrl)}>
            <ExternalIcon />
          </IconButton>
        )}
      </div>
      <div
        ref={scrollRef}
        onWheel={(e) => e.deltaY < 0 && follow && setFollow(false)}
        className="min-h-0 flex-1 overflow-auto bg-black py-1.5 font-mono text-[11.5px] leading-[18px]"
      >
        {!hasLog && <Note>This job hasn't run{job.status === "manual" ? " — it's a manual job" : ""}.</Note>}
        {hasLog && error && !log && (
          <Note>
            {running
              ? "No log yet — GitHub publishes a job's log once it finishes."
              : `Couldn't load the log: ${error}`}
          </Note>
        )}
        {hasLog && !error && !log && <Note>Loading log…</Note>}
        {log?.truncated && <Note>Showing the end of a long log.</Note>}
        {log?.sections.map((sec, i) => {
          const isOpen = !sec.name || (open?.has(i) ?? false);
          const secLines = lines[i] ?? [];
          const first = lineNo;
          lineNo += secLines.length;
          const failed = sec.status === "failed" || (i === focus && job.status === "failed");
          // Long sections render their tail; a search hit above it reveals all.
          const cap = Math.max(0, secLines.length - SECTION_LINE_CAP);
          const hidden = current?.s === i && current.l < cap ? 0 : cap;
          return (
            <div key={i}>
              {sec.name && (
                <button
                  onClick={() => toggle(i)}
                  className={cn(
                    "flex h-[22px] w-full items-center gap-1 px-3.5 text-left hover:bg-neutral-900",
                    failed && "bg-red-950/25",
                  )}
                >
                  <span className="w-3 text-neutral-500">{isOpen ? "▾" : "▸"}</span>
                  <SectionDot status={sec.status} />
                  <span className={cn("truncate font-medium", failed ? "text-red-300" : "text-neutral-400")}>
                    {sec.name}
                  </span>
                  <span className="flex-1" />
                  {sec.durationSecs !== null && (
                    <span className="text-neutral-600">{formatDuration(sec.durationSecs)}</span>
                  )}
                </button>
              )}
              {isOpen &&
                secLines.slice(hidden).map((segs, k) => {
                  const l = hidden + k;
                  const hit = matchSet.has(`${i}:${l}`);
                  const cur = current?.s === i && current.l === l;
                  return (
                    <div
                      key={l}
                      data-line={`${i}:${l}`}
                      className={cn(
                        "flex pl-3.5",
                        cur ? "bg-amber-500/25" : hit ? "bg-amber-500/10" : undefined,
                      )}
                    >
                      <span className="w-10 shrink-0 select-none pr-3 text-right text-neutral-700">
                        {first + l}
                      </span>
                      <span className="whitespace-pre text-neutral-300">
                        {segs.map((s, n) => (
                          <span key={n} style={s.style}>
                            {s.text}
                          </span>
                        ))}
                      </span>
                    </div>
                  );
                })}
              {isOpen && hidden > 0 && (
                <Note>{hidden} earlier lines not shown — search reaches them.</Note>
              )}
            </div>
          );
        })}
        {log && log.sections.length === 0 && <Note>The log is empty.</Note>}
        {log && running && <Note>{follow ? "Following…" : "Running…"}</Note>}
      </div>
    </div>
  );
}

function statusText(status: string): string {
  if (status === "failed") return "text-red-300";
  if (status === "success") return "text-emerald-300";
  if (status === "running") return "text-blue-300";
  return "text-neutral-300";
}

function pipColor(status: string): string {
  const v = ciStatusVisual(status);
  // Hollow states read as faint bars in the strip.
  return v.dot.includes("bg-transparent") ? "bg-neutral-700" : v.dot;
}

function StatusDot({ status }: { status: string }) {
  if (status === "warn") {
    return <span title="failed (allowed to fail)" className="h-2 w-2 shrink-0 rounded-full bg-orange-500" />;
  }
  const v = ciStatusVisual(status);
  return (
    <span
      title={v.label}
      className={cn("h-2 w-2 shrink-0 rounded-full", v.dot, v.pulse && "animate-pulse")}
    />
  );
}

/// GitHub steps have a status; GitLab sections don't — no dot for those.
function SectionDot({ status }: { status: string | null }) {
  if (!status) return null;
  const v = ciStatusVisual(status);
  return <span title={v.label} className={cn("mr-1 h-1.5 w-1.5 shrink-0 rounded-full", v.dot)} />;
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[5px] border border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
    >
      {children}
    </button>
  );
}

function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="px-3.5 py-1 font-sans text-xs text-neutral-600">{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-1 items-center justify-center text-xs text-neutral-600">
      {children}
    </div>
  );
}
