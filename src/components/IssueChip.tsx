import { useEffect, useRef, useState } from "react";
import { CircleDot, Plus } from "lucide-react";
import type { ForgeIssue, WorkspaceId, WorktreeId } from "@/ipc/types";
import {
  forgeGetIssue,
  forgeIssuePrompt,
  forgeListIssues,
  forgeSetIssueAssignee,
  openExternalUrl,
} from "@/ipc/client";
import { useForgeStore } from "@/stores/forge";
import { useIssueLinksStore } from "@/stores/issueLinks";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { pasteAndSubmit } from "@/lib/agent";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import { asMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";

/// The issue this worktree is working on — its stored link (set when created
/// from an issue, or here via "Link issue"), never parsed from the branch
/// name. A chip in the diff header (next to the MR pill): click to read the
/// description, self-assign, send the issue to the active agent, or unlink.
/// Unlinked, it's a dashed "Link issue" picker (only when the forge is
/// reachable).
export function IssueChip({
  workspaceId,
  worktreeId,
  branch,
}: {
  workspaceId: WorkspaceId;
  worktreeId: WorktreeId;
  branch: string;
}) {
  const path = useWorktreesStore(
    (s) => s.worktrees.find((w) => w.id === worktreeId)?.path ?? null,
  );
  const number = useIssueLinksStore((s) => (path ? s.byPath[path] : undefined)) ?? null;
  const setLink = useIssueLinksStore((s) => s.setLink);

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
      // Forge unreachable → leave the chip unlabeled.
    }
  }

  useEffect(() => {
    void loadStatus(workspaceId);
  }, [workspaceId, loadStatus]);

  useEffect(() => {
    setIssue(null);
    setOpen(false);
    if (number != null) void refresh();
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

  if (!path) return null;

  if (number == null) {
    if (!status?.authenticated) return null;
    return (
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex items-center gap-1 rounded border border-dashed border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200",
            open && "border-neutral-500 text-neutral-200",
          )}
          title="Link this worktree to an issue"
        >
          <Plus size={11} />
          Link issue
        </button>
        {open && (
          <LinkIssuePicker
            workspaceId={workspaceId}
            branch={branch}
            onPick={async (n) => {
              setOpen(false);
              await setLink(path, n);
            }}
          />
        )}
      </div>
    );
  }

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
    try {
      await pasteAndSubmit(activeAgentId, await forgeIssuePrompt(workspaceId, issue.number));
      toastSuccess(`Sent issue #${issue.number} to agent`);
    } catch (e) {
      toastError("Couldn't send to agent", asMessage(e));
    }
  }

  async function unlink() {
    if (!path) return;
    setOpen(false);
    if (await setLink(path, null)) toastInfo(`Unlinked #${number}`);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={issue ? issue.title : `Issue #${number}`}
        className={cn(
          "flex items-center gap-1 rounded border border-blue-900 bg-blue-950/30 px-1.5 py-0.5 text-[11px] text-neutral-300 hover:bg-blue-950/60",
          open && "bg-blue-950/60",
        )}
      >
        <CircleDot size={11} className="text-blue-300" />
        <span className="font-mono text-blue-200">#{number}</span>
        {issue && <span className="max-w-[16rem] truncate">{issue.title}</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-[120%] z-30 w-[26rem] rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl">
          {issue ? (
            <>
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
                {issue.body || <span className="text-neutral-600">No description.</span>}
              </div>
            </>
          ) : (
            <div className="px-3 py-2 text-xs text-neutral-500">
              Couldn't load #{number} from the forge.
            </div>
          )}
          <div className="flex items-center gap-2 border-t border-neutral-800 px-3 py-2">
            <button
              onClick={() => void unlink()}
              className="rounded px-1.5 py-1 text-[11px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
              title="Remove the link (the PR won't close this issue)"
            >
              Unlink
            </button>
            <span className="flex-1" />
            {issue && (
              <>
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
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/// Search-and-pick popover for linking an issue. A branch that starts with
/// `<n>-` (the create-from-issue naming, or a worktree from before links
/// were stored) gets #n offered first — as a suggestion, never auto-linked.
function LinkIssuePicker({
  workspaceId,
  branch,
  onPick,
}: {
  workspaceId: WorkspaceId;
  branch: string;
  onPick: (n: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ForgeIssue[] | null>(null);
  const [suggested, setSuggested] = useState<ForgeIssue | null>(null);

  useEffect(() => {
    const m = branch.match(/^(\d+)-/);
    if (!m) return;
    forgeGetIssue(workspaceId, Number(m[1]))
      .then(setSuggested)
      .catch(() => {});
  }, [workspaceId, branch]);

  useEffect(() => {
    const id = setTimeout(() => {
      forgeListIssues(workspaceId, query, "open", 20)
        .then(setResults)
        .catch((e) => {
          setResults([]);
          toastError("Couldn't load issues", asMessage(e));
        });
    }, 250);
    return () => clearTimeout(id);
  }, [workspaceId, query]);

  const rows = [
    ...(suggested && !query.trim() ? [suggested] : []),
    ...(results ?? []).filter((i) => !(suggested && !query.trim() && i.number === suggested.number)),
  ];

  return (
    <div className="absolute left-0 top-[120%] z-30 w-[24rem] overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl">
      <div className="border-b border-neutral-800 p-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && rows[0]) onPick(rows[0].number);
          }}
          placeholder="Find an issue to link…"
          aria-label="Find an issue to link"
          className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
        />
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {results === null ? (
          <div className="px-3 py-2 text-xs text-neutral-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-2 text-xs text-neutral-500">No matching open issues.</div>
        ) : (
          rows.map((i, k) => (
            <button
              key={i.number}
              onClick={() => onPick(i.number)}
              className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs hover:bg-neutral-800"
            >
              <span className="w-10 shrink-0 text-right font-mono text-[11px] text-neutral-500">
                #{i.number}
              </span>
              <span className="min-w-0 flex-1 truncate text-neutral-200">{i.title}</span>
              {k === 0 && suggested && !query.trim() && (
                <span className="shrink-0 text-[10px] text-neutral-500">from branch name</span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
