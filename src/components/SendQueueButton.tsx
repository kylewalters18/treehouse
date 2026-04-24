import { useEffect, useMemo, useRef, useState } from "react";
import { pasteAndSubmit } from "@/lib/agent";
import { listAgentsForWorktree } from "@/ipc/client";
import type { AgentSession, AgentSessionId } from "@/ipc/types";
import { useCommentsStore, formatBatchForAgent } from "@/stores/comments";
import { useDiffsStore } from "@/stores/diffs";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { useWorkspaceStore } from "@/stores/workspace";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import { asMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";

/// Workspace-header pill that surfaces the queue of comments scoped to
/// the selected worktree. Clicking opens a dropdown listing each queued
/// comment — jump-to-line, remove, and a "Preview prompt" expander — so
/// the user doesn't have to navigate back to each file to audit the
/// batch before sending.
export function SendQueueButton() {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const selected = worktrees.find((w) => w.id === selectedWorktreeId) ?? null;
  const activeAgentId = useUiStore((s) =>
    selectedWorktreeId ? s.activeAgentByWorktree[selectedWorktreeId] ?? null : null,
  );
  const items = useCommentsStore((s) => s.items);
  const queue = useCommentsStore((s) => s.queue);
  const toggleQueue = useCommentsStore((s) => s.toggleQueue);
  const resolveComment = useCommentsStore((s) => s.resolve);
  const selectFile = useDiffsStore((s) => s.selectFile);
  const setView = useDiffsStore((s) => s.setView);
  const setPendingReveal = useDiffsStore((s) => s.setPendingReveal);

  const [open, setOpen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [agents, setAgents] = useState<AgentSession[]>([]);
  const [targetAgentId, setTargetAgentId] = useState<AgentSessionId | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Queued comments scoped to the currently-selected worktree's branch.
  const queued = useMemo(() => {
    if (!workspace || !selected) return [];
    return items.filter(
      (c) =>
        queue.has(c.id) &&
        c.workspaceRoot === workspace.root &&
        c.branch === selected.branch &&
        c.resolvedAt === null,
    );
  }, [workspace, selected, items, queue]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Auto-close the dropdown when the queue empties (e.g. after Send all).
  useEffect(() => {
    if (queued.length === 0) setOpen(false);
  }, [queued.length]);

  // Refresh the agent list when the dropdown opens so the picker reflects
  // any agents launched since the last time it was shown. Preselect the
  // currently-active-tab agent — that's what the pill used to do before
  // we exposed the picker, and matches the "send to the one you're
  // looking at" default. Filter to running/starting statuses so the
  // target is always sendable.
  useEffect(() => {
    if (!open || !selectedWorktreeId) return;
    let cancelled = false;
    listAgentsForWorktree(selectedWorktreeId)
      .then((list) => {
        if (cancelled) return;
        const sendable = list.filter(
          (a) =>
            a.status.kind === "running" || a.status.kind === "starting",
        );
        setAgents(sendable);
        // Preserve prior selection if still present; otherwise fall back
        // to the active agent, then the first sendable one.
        setTargetAgentId((prev) => {
          if (prev && sendable.some((a) => a.id === prev)) return prev;
          if (activeAgentId && sendable.some((a) => a.id === activeAgentId)) {
            return activeAgentId;
          }
          return sendable[0]?.id ?? null;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setAgents([]);
        setTargetAgentId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedWorktreeId, activeAgentId]);

  if (queued.length === 0) return null;

  function jumpTo(filePath: string, line: number) {
    if (!selectedWorktreeId) return;
    setView(selectedWorktreeId, "file");
    selectFile(selectedWorktreeId, filePath);
    setPendingReveal(selectedWorktreeId, { path: filePath, line, column: 1 });
    setOpen(false);
  }

  async function send() {
    if (!targetAgentId) {
      toastInfo("No agent selected");
      return;
    }
    try {
      await pasteAndSubmit(targetAgentId, formatBatchForAgent(queued));
      toastSuccess(
        `Sent ${queued.length} comment${queued.length === 1 ? "" : "s"}`,
        "Marking as resolved.",
      );
      for (const c of queued) {
        await resolveComment(c.id);
      }
    } catch (e) {
      toastError("Couldn't send batch", asMessage(e));
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`${queued.length} queued comment${queued.length === 1 ? "" : "s"}`}
        className={cn(
          "rounded border border-blue-700 bg-blue-950/40 px-2 py-1 text-[11px] font-medium text-blue-200 hover:bg-blue-950/60",
          open && "bg-blue-950/70",
        )}
      >
        Send queue ({queued.length})
      </button>
      {open && (
        <div className="absolute right-0 top-[110%] z-30 w-[28rem] rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl">
          <div className="max-h-80 overflow-y-auto">
            <ul className="flex flex-col divide-y divide-neutral-800">
              {queued.map((c) => (
                <li key={c.id} className="p-3 hover:bg-neutral-950/60">
                  <div className="flex items-start gap-2">
                    <button
                      onClick={() => jumpTo(c.filePath, c.line)}
                      className="font-mono text-[11px] text-blue-300 hover:underline"
                      title="Jump to this comment in the editor"
                    >
                      {c.filePath}:{c.line}
                    </button>
                    <span className="flex-1" />
                    <button
                      onClick={() => toggleQueue(c.id)}
                      title="Remove from queue (keeps the comment)"
                      className="rounded border border-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
                    >
                      Unqueue
                    </button>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-xs text-neutral-200">
                    {c.text}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="border-t border-neutral-800">
            <button
              onClick={() => setShowPreview((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300"
            >
              <span>Preview prompt</span>
              <span>{showPreview ? "−" : "+"}</span>
            </button>
            {showPreview && (
              <pre className="max-h-48 overflow-auto border-t border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-[11px] text-neutral-300">
                {formatBatchForAgent(queued)}
              </pre>
            )}
          </div>
          <div className="border-t border-neutral-800 px-3 py-2">
            <div className="mb-1 text-[11px] uppercase tracking-wider text-neutral-500">
              Send to
            </div>
            {agents.length === 0 ? (
              <div className="text-[11px] text-neutral-500">
                No running agents in this worktree
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {agents.map((a) => (
                  <label
                    key={a.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded border px-2 py-1 text-xs",
                      targetAgentId === a.id
                        ? "border-blue-700 bg-blue-950/30"
                        : "border-neutral-800 hover:bg-neutral-950",
                    )}
                  >
                    <input
                      type="radio"
                      checked={targetAgentId === a.id}
                      onChange={() => setTargetAgentId(a.id)}
                      className="accent-blue-600"
                    />
                    <span className="min-w-0 flex-1">
                      <div className="truncate text-neutral-100">
                        {backendLabel(a)}
                        {a.id === activeAgentId && (
                          <span className="ml-1 text-[10px] text-neutral-500">
                            (active tab)
                          </span>
                        )}
                      </div>
                      <div className="truncate font-mono text-[10px] text-neutral-500">
                        {a.argv.join(" ")}
                      </div>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-neutral-800 px-3 py-2">
            <button
              onClick={send}
              disabled={!targetAgentId}
              className="rounded border border-blue-700 bg-blue-950/40 px-2 py-1 text-[11px] font-medium text-blue-200 hover:bg-blue-950/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send all ({queued.length})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/// Display label for an agent row. Backend kinds come through as
/// `"claudeCode" | "codex" | "kiro"`; camelCase isn't user-friendly,
/// so map to human strings.
function backendLabel(a: AgentSession): string {
  switch (a.backend) {
    case "claudeCode":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "kiro":
      return "Kiro";
  }
}
