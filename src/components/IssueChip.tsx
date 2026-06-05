import { useEffect, useRef, useState } from "react";
import type { ForgeIssue, WorkspaceId, WorktreeId } from "@/ipc/types";
import { forgeGetIssue, forgeSetIssueAssignee, openExternalUrl } from "@/ipc/client";
import { useForgeStore } from "@/stores/forge";
import { useUiStore } from "@/stores/ui";
import { pasteAndSubmit } from "@/lib/agent";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import { asMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";

/// The issue this worktree is working on, derived from the `<n>-slug` branch
/// name. A chip in the diff header (next to the MR pill); click to read the
/// description, self-assign, or send the issue to the worktree's active agent.
/// Renders nothing for a branch with no leading issue number.
export function IssueChip({
  workspaceId,
  worktreeId,
  branch,
}: {
  workspaceId: WorkspaceId;
  worktreeId: WorktreeId;
  branch: string;
}) {
  const number = issueNumberFromBranch(branch);

  const [issue, setIssue] = useState<ForgeIssue | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const status = useForgeStore((s) => s.status[workspaceId]);
  const loadStatus = useForgeStore((s) => s.loadStatus);
  const me = status?.username ?? null;
  const activeAgentId = useUiStore(
    (s) => s.activeAgentByWorktree[worktreeId] ?? null,
  );

  async function refresh() {
    if (number == null) return;
    try {
      setIssue(await forgeGetIssue(workspaceId, number));
    } catch {
      // No forge / not an issue branch → leave the chip unlabeled.
    }
  }

  useEffect(() => {
    setIssue(null);
    if (number != null) {
      void refresh();
      void loadStatus(workspaceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number, workspaceId]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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

  if (number == null) return null;

  const assignedToMe = !!me && (issue?.assignees ?? []).includes(me);

  async function toggleAssign() {
    if (number == null) return;
    setBusy(true);
    try {
      await forgeSetIssueAssignee(workspaceId, number, !assignedToMe);
      await refresh();
    } catch (e) {
      toastError("Couldn't update assignee", asMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendToAgent() {
    if (!issue) return;
    if (!activeAgentId) {
      toastInfo("No active agent in this worktree");
      return;
    }
    const prompt = `Work on issue #${issue.number}: ${issue.title}\n\n${issue.body}`;
    try {
      await pasteAndSubmit(activeAgentId, prompt);
      toastSuccess(`Sent issue #${issue.number} to agent`);
    } catch (e) {
      toastError("Couldn't send to agent", asMessage(e));
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={issue ? issue.title : `Issue #${number}`}
        className={cn(
          "flex items-center gap-1 rounded border border-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800",
          open && "bg-neutral-800",
        )}
      >
        <span>📋</span>
        <span className="font-mono text-neutral-400">#{number}</span>
        {issue && <span className="max-w-[12rem] truncate">{issue.title}</span>}
      </button>
      {open && issue && (
        <div className="absolute left-0 top-[120%] z-30 w-[26rem] rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl">
          <div className="flex items-start gap-2 border-b border-neutral-800 p-2">
            <span className="mt-0.5 font-mono text-[11px] text-neutral-500">
              #{issue.number}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-neutral-100">{issue.title}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                {issue.labels.slice(0, 5).map((l) => (
                  <span
                    key={l}
                    className="rounded bg-neutral-800 px-1.5 py-[1px] text-[10px] text-neutral-300"
                  >
                    {l}
                  </span>
                ))}
                {issue.assignees.length > 0 && (
                  <span className="text-[10px] text-neutral-500">
                    @{issue.assignees[0]}
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={() => void openExternalUrl(issue.url)}
              className="rounded border border-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
              title="Open in browser"
            >
              ↗
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap px-3 py-2 text-xs text-neutral-300">
            {issue.body || (
              <span className="text-neutral-600">No description.</span>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-neutral-800 px-3 py-2">
            <button
              disabled={busy}
              onClick={() => void toggleAssign()}
              className={cn(
                "rounded border px-2 py-1 text-[11px] font-medium disabled:opacity-50",
                assignedToMe
                  ? "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
                  : "border-emerald-700 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-950/60",
              )}
            >
              {assignedToMe ? "✓ Assigned to you — unassign" : "Assign to me"}
            </button>
            <button
              onClick={() => void sendToAgent()}
              className="rounded border border-blue-700 bg-blue-950/40 px-2 py-1 text-[11px] font-medium text-blue-200 hover:bg-blue-950/60"
              title="Send the issue to this worktree's active agent"
            >
              → Send to agent
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/// Parse the leading issue number from a `<n>-slug` branch name.
function issueNumberFromBranch(branch: string): number | null {
  const m = branch.match(/^(\d+)-/);
  return m ? Number(m[1]) : null;
}
