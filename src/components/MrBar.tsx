import { useEffect, useState } from "react";
import type { WorkspaceId } from "@/ipc/types";
import { openExternalUrl } from "@/ipc/client";
import { useForgeStore, forgeBranchKey } from "@/stores/forge";
import { toastInfo, toastSuccess } from "@/stores/toasts";
import { cn } from "@/lib/cn";

/// Strip above the diff showing the MR linked to the worktree's branch:
/// pill + open-in-browser, Create when none, and Approve / Merge when one
/// exists. MR comments (general + inline) live in the Review tab.
export function MrBar({
  workspaceId,
  branch,
}: {
  workspaceId: WorkspaceId;
  branch: string;
}) {
  const mr = useForgeStore((s) => s.mrByBranch[forgeBranchKey(workspaceId, branch)]);
  const findMr = useForgeStore((s) => s.findMr);
  const createMr = useForgeStore((s) => s.createMr);
  const approveMr = useForgeStore((s) => s.approveMr);
  const unapproveMr = useForgeStore((s) => s.unapproveMr);
  const loadApproval = useForgeStore((s) => s.loadApproval);
  const mergeMr = useForgeStore((s) => s.mergeMr);
  const approval = useForgeStore((s) =>
    mr ? s.approvalByMr[`${workspaceId}::mr::${mr.number}`] : undefined,
  );

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mr === undefined) void findMr(workspaceId, branch);
  }, [mr, workspaceId, branch, findMr]);

  // Load the current user's approval state so Approve can toggle to Unapprove.
  useEffect(() => {
    if (mr) void loadApproval(workspaceId, mr.number);
  }, [mr, workspaceId, loadApproval]);

  function startCreate() {
    setTitle(titleFromBranch(branch));
    setCreating(true);
  }

  async function confirmCreate() {
    setBusy(true);
    const result = await createMr(workspaceId, branch, title.trim() || branch, null, false);
    setBusy(false);
    if (result) setCreating(false);
  }

  async function onToggleApprove() {
    if (!mr) return;
    setBusy(true);
    if (approval?.approved) {
      const ok = await unapproveMr(workspaceId, mr.number);
      if (ok) toastInfo(`Revoked approval on !${mr.number}`);
    } else {
      const ok = await approveMr(workspaceId, mr.number);
      if (ok) toastSuccess(`Approved !${mr.number}`);
    }
    setBusy(false);
  }

  async function onMerge() {
    if (!mr) return;
    if (
      !window.confirm(
        `Merge !${mr.number} into its target branch (using the project's merge method)? This closes the linked issue.`,
      )
    )
      return;
    setBusy(true);
    const ok = await mergeMr(workspaceId, branch, mr.number);
    setBusy(false);
    if (ok) toastSuccess(`Merged !${mr.number}`);
  }

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-3 text-xs">
      {mr === undefined ? (
        <span className="text-neutral-600">…</span>
      ) : mr === null ? (
        creating ? (
          <>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="MR title"
              className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-neutral-100 focus:border-neutral-500 focus:outline-none"
            />
            <button
              disabled={busy}
              onClick={() => void confirmCreate()}
              className="rounded border border-blue-700 bg-blue-950/40 px-2 py-0.5 font-medium text-blue-200 hover:bg-blue-950/60 disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create"}
            </button>
            <button
              onClick={() => setCreating(false)}
              className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-400 hover:bg-neutral-800"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <span className="text-neutral-500">No MR for this branch</span>
            <span className="flex-1" />
            <button
              onClick={startCreate}
              className="rounded border border-blue-700 bg-blue-950/40 px-2 py-0.5 font-medium text-blue-200 hover:bg-blue-950/60"
            >
              Create MR
            </button>
          </>
        )
      ) : (
        <>
          <button
            onClick={() => void openExternalUrl(mr.url)}
            className="min-w-0 truncate text-left text-neutral-200 hover:underline"
            title="Open MR in browser"
          >
            <span className="font-mono text-neutral-400">!{mr.number}</span>{" "}
            {mr.title}
          </button>
          {mr.draft && (
            <span className="rounded bg-neutral-800 px-1.5 py-[1px] text-[10px] text-neutral-400">
              draft
            </span>
          )}
          <span
            className={cn(
              "rounded px-1.5 py-[1px] text-[10px]",
              mr.state === "merged"
                ? "bg-purple-950/50 text-purple-300"
                : mr.state === "closed"
                  ? "bg-rose-950/50 text-rose-300"
                  : "bg-emerald-950/50 text-emerald-300",
            )}
          >
            {mr.state}
          </span>
          <span className="flex-1" />
          {mr.state === "open" && mergeBlocker(mr.mergeStatus) && (
            <span
              className="rounded bg-amber-950/40 px-1.5 py-[1px] text-[10px] text-amber-300"
              title={`Can't merge yet: ${mergeBlocker(mr.mergeStatus)}`}
            >
              ⚠ {mergeBlocker(mr.mergeStatus)}
            </span>
          )}
          {mr.state === "open" && (
            <>
              <button
                disabled={busy}
                onClick={() => void onToggleApprove()}
                className={cn(
                  "rounded border px-2 py-0.5 font-medium disabled:opacity-50",
                  approval?.approved
                    ? "border-amber-700 bg-amber-950/40 text-amber-200 hover:bg-amber-950/60"
                    : "border-emerald-700 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-950/60",
                )}
                title={
                  approval?.approved
                    ? "Revoke your approval"
                    : "Approve this MR"
                }
              >
                {approval?.approved ? "Unapprove" : "Approve"}
              </button>
              <button
                disabled={busy}
                onClick={() => void onMerge()}
                title="Merge using the project's configured merge method"
                className="rounded border border-blue-700 bg-blue-950/40 px-2 py-0.5 font-medium text-blue-200 hover:bg-blue-950/60 disabled:opacity-50"
              >
                {busy ? "…" : "Merge"}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

/// Human label for GitLab's `detailed_merge_status` when it blocks merging.
/// Returns null when the MR is mergeable (no blocker to show).
function mergeBlocker(status: string | null): string | null {
  if (!status || status === "mergeable" || status === "can_be_merged") return null;
  const map: Record<string, string> = {
    discussions_not_resolved: "unresolved threads",
    ci_must_pass: "CI must pass",
    ci_still_running: "CI running",
    not_approved: "needs approval",
    draft_status: "draft",
    conflict: "conflicts",
    need_rebase: "needs rebase",
    requested_changes: "changes requested",
    blocked_status: "blocked by another MR",
    not_open: "not open",
  };
  return map[status] ?? status.replace(/_/g, " ");
}

/// Derive a default MR title from a `<n>-slug` branch name:
/// `1-add-ci-pipeline` → `Add ci pipeline`.
function titleFromBranch(branch: string): string {
  const parts = branch.split("-");
  if (parts.length > 1 && /^\d+$/.test(parts[0])) parts.shift();
  const text = parts.join(" ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : branch;
}
