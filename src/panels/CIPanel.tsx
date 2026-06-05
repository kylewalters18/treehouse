import { useCallback, useEffect, useRef, useState } from "react";
import type { ForgeJob, ForgePipeline } from "@/ipc/types";
import {
  forgePipelineJobs,
  forgeJobLog,
  openExternalUrl,
} from "@/ipc/client";
import { useForgeStore, forgeBranchKey } from "@/stores/forge";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { workspaceForWorktree } from "@/stores/workspace";
import { pasteAndSubmit } from "@/lib/agent";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import { asMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";

const TERMINAL_STATES = ["success", "failed", "canceled", "skipped", "manual"];

/// CI panel for the selected worktree's branch: latest pipeline + jobs, retry,
/// and the keystone "Send failing log to agent". Polls while a run is active.
export function CIPanel() {
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const selected = worktrees.find((w) => w.id === selectedWorktreeId) ?? null;
  const workspace = workspaceForWorktree(selected?.workspaceId);
  const activeAgentId = useUiStore((s) =>
    selectedWorktreeId ? s.activeAgentByWorktree[selectedWorktreeId] ?? null : null,
  );

  const pipelines = useForgeStore((s) =>
    workspace && selected
      ? s.pipelinesByBranch[forgeBranchKey(workspace.id, selected.branch)]
      : undefined,
  );
  const loadPipelines = useForgeStore((s) => s.loadPipelines);
  const retryPipeline = useForgeStore((s) => s.retryPipeline);

  const latest: ForgePipeline | undefined = pipelines?.[0];
  const [jobs, setJobs] = useState<ForgeJob[]>([]);
  const [expandedLog, setExpandedLog] = useState<Record<number, string>>({});

  const wsId = workspace?.id ?? null;
  const branch = selected?.branch ?? null;

  // Load pipelines on branch change.
  useEffect(() => {
    if (wsId && branch) void loadPipelines(wsId, branch);
  }, [wsId, branch, loadPipelines]);

  // Load jobs for the latest pipeline.
  const loadJobs = useCallback(async () => {
    if (!wsId || !latest) {
      setJobs([]);
      return;
    }
    try {
      setJobs(await forgePipelineJobs(wsId, latest.id));
    } catch (e) {
      console.warn("load jobs failed", asMessage(e));
    }
  }, [wsId, latest]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  // Poll while the latest pipeline is non-terminal.
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    const active = latest && !TERMINAL_STATES.includes(latest.status);
    if (!active || !wsId || !branch) return;
    pollRef.current = window.setInterval(() => {
      void loadPipelines(wsId, branch);
      void loadJobs();
    }, 5000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [latest, wsId, branch, loadPipelines, loadJobs]);

  if (!selected) {
    return <Empty>Select a worktree to see its pipelines.</Empty>;
  }
  if (!pipelines) {
    return <Empty>Loading pipelines…</Empty>;
  }
  if (!latest) {
    return <Empty>No pipelines for {selected.branch}.</Empty>;
  }

  async function sendToAgent(job: ForgeJob) {
    if (!wsId) return;
    if (!activeAgentId) {
      toastInfo("No active agent in this worktree");
      return;
    }
    try {
      const log = await forgeJobLog(wsId, job.id);
      const failed = job.status === "failed";
      const lead = failed
        ? `The CI job \`${job.name}\` failed.`
        : `Here is the log for CI job \`${job.name}\` (${job.status}).`;
      const ask = failed
        ? "Please diagnose and fix the cause."
        : "Use it as context.";
      const prompt = `${lead} Log:\n\n\`\`\`\n${log}\n\`\`\`\n\n${ask}`;
      await pasteAndSubmit(activeAgentId, prompt);
      toastSuccess(`Sent ${job.name} log to agent`, failed ? "Asked it to fix." : "Sent as context.");
    } catch (e) {
      toastError("Couldn't send log", asMessage(e));
    }
  }

  async function toggleLog(job: ForgeJob) {
    if (!wsId) return;
    if (expandedLog[job.id] !== undefined) {
      setExpandedLog((m) => {
        const next = { ...m };
        delete next[job.id];
        return next;
      });
      return;
    }
    try {
      const log = await forgeJobLog(wsId, job.id);
      setExpandedLog((m) => ({ ...m, [job.id]: log }));
    } catch (e) {
      toastError("Couldn't load log", asMessage(e));
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-neutral-950 p-2 text-sm">
      <div className="mb-2 flex items-center gap-2 px-1">
        <StatusDot status={latest.status} />
        <span className="font-mono text-[11px] text-neutral-400">
          pipeline #{latest.id}
        </span>
        <span className="text-neutral-300">{latest.status}</span>
        <span className="text-neutral-600">·</span>
        <span className="font-mono text-[11px] text-neutral-500">
          {selected.branch}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => wsId && void retryPipeline(wsId, selected.branch, latest.id)}
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
          title="Retry pipeline"
        >
          ⟳ Retry
        </button>
        <button
          onClick={() => void openExternalUrl(latest.webUrl)}
          className="rounded border border-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
          title="Open pipeline in browser"
        >
          ↗
        </button>
      </div>
      <ul className="flex flex-col gap-1">
        {jobs.map((job) => {
          const failed = job.status === "failed";
          // A trace only exists once a job has started; hide the buttons for
          // not-yet-run jobs (created / manual / skipped) where it'd be empty.
          const hasLog = !["created", "manual", "skipped"].includes(job.status);
          return (
            <li
              key={job.id}
              className="rounded border border-neutral-900 bg-neutral-900/40"
            >
              <div className="flex items-center gap-2 px-2 py-1.5">
                <StatusDot status={job.status} />
                <span className="text-neutral-200">{job.name}</span>
                {job.stage && (
                  <span className="font-mono text-[10px] text-neutral-600">
                    ({job.stage})
                  </span>
                )}
                <span className="flex-1" />
                {hasLog && (
                  <>
                    <button
                      onClick={() => void toggleLog(job)}
                      className="rounded border border-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
                    >
                      {expandedLog[job.id] !== undefined ? "Hide log" : "View log"}
                    </button>
                    <button
                      onClick={() => void sendToAgent(job)}
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[11px] font-medium",
                        failed
                          ? "border-blue-700 bg-blue-950/40 text-blue-200 hover:bg-blue-950/60"
                          : "border-neutral-700 text-neutral-300 hover:bg-neutral-800",
                      )}
                      title={
                        failed
                          ? "Send the failing log to the active agent"
                          : "Send this job's log to the active agent as context"
                      }
                    >
                      → Send to agent
                    </button>
                  </>
                )}
              </div>
              {expandedLog[job.id] !== undefined && (
                <pre className="max-h-64 overflow-auto border-t border-neutral-800 bg-black px-2 py-1.5 font-mono text-[11px] text-neutral-300">
                  {expandedLog[job.id]}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-neutral-950 p-4 text-sm text-neutral-500">
      {children}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "success"
      ? "bg-emerald-500"
      : status === "failed"
        ? "bg-red-500"
        : status === "running" || status === "pending" || status === "created"
          ? "bg-amber-500"
          : "bg-neutral-600";
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", color)} />;
}
