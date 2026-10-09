import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { RemoteBranchState, WorkspaceId } from "@/ipc/types";
import {
  forgeBranchRemoteState,
  forgeGetIssue,
  forgePushBranch,
  onMrChanged,
  openExternalUrl,
} from "@/ipc/client";
import { useIssueLinksStore } from "@/stores/issueLinks";
import { useWorktreesStore } from "@/stores/worktrees";
import { useForgeStore, forgeBranchKey, useForgeTerms } from "@/stores/forge";
import { IssueChip } from "@/components/IssueChip";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import { asMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";
import type { WorktreeId } from "@/ipc/types";

/// Strip above the diff showing the MR linked to the worktree's branch:
/// pill + open-in-browser, Create when none, and Approve / Merge when one
/// exists. MR comments (general + inline) live in the Review tab. Creating
/// opens a small form below the strip; a worktree with a linked issue gets
/// its title and a `Closes #n` line by default. Creating never pushes: the
/// form checks origin and offers Push until the branch is there, up to date.
export function MrBar({
  workspaceId,
  worktreeId,
  branch,
}: {
  workspaceId: WorkspaceId;
  worktreeId: WorktreeId;
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
  const terms = useForgeTerms(workspaceId);
  const path = useWorktreesStore(
    (s) => s.worktrees.find((w) => w.id === worktreeId)?.path ?? null,
  );
  const linkedIssue =
    useIssueLinksStore((s) => (path ? s.byPath[path] : undefined)) ?? null;

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  /// The branch on origin while the form is open; null = checking, "unknown"
  /// = the check failed (Create stays enabled and the backend decides).
  const [remote, setRemote] = useState<RemoteBranchState | "unknown" | null>(null);
  const [pushing, setPushing] = useState(false);
  const closesLine = linkedIssue != null ? `Closes #${linkedIssue}` : null;
  const closes = closesLine != null && hasLine(body, closesLine);

  useEffect(() => {
    if (mr === undefined) void findMr(workspaceId, branch);
  }, [mr, workspaceId, branch, findMr]);

  // An agent opening this branch's PR over MCP (or another window) — refetch.
  useEffect(() => {
    const p = onMrChanged(workspaceId, (b) => {
      if (b === branch) void findMr(workspaceId, branch);
    });
    return () => {
      void p.then((un) => un());
    };
  }, [workspaceId, branch, findMr]);

  // Load the current user's approval state so Approve can toggle to Unapprove.
  useEffect(() => {
    if (mr) void loadApproval(workspaceId, mr.number);
  }, [mr, workspaceId, loadApproval]);

  function checkRemote() {
    setRemote(null);
    forgeBranchRemoteState(workspaceId, branch)
      .then(setRemote)
      .catch(() => setRemote("unknown"));
  }

  async function push() {
    setPushing(true);
    try {
      await forgePushBranch(workspaceId, branch);
      setRemote("matches");
    } catch (e) {
      toastError("Couldn't push", asMessage(e));
      checkRemote();
    } finally {
      setPushing(false);
    }
  }

  const needsPush = remote === "missing" || remote === "differs";
  const canCreate = !busy && !pushing && remote !== null && !needsPush;

  function startCreate() {
    checkRemote();
    setTitle(titleFromBranch(branch));
    setBody(closesLine ?? "");
    setDraft(false);
    setCreating(true);
    // Prefer the linked issue's title; keep the branch-derived one if the
    // fetch fails or the user already started typing.
    if (linkedIssue != null) {
      const fallback = titleFromBranch(branch);
      forgeGetIssue(workspaceId, linkedIssue)
        .then((i) => setTitle((t) => (t === fallback ? i.title : t)))
        .catch(() => {});
    }
  }

  function toggleCloses(on: boolean) {
    if (!closesLine) return;
    setBody((b) => (on ? addLine(b, closesLine) : removeLine(b, closesLine)));
  }

  async function confirmCreate() {
    if (!canCreate) return;
    setBusy(true);
    const result = await createMr(
      workspaceId,
      branch,
      title.trim() || branch,
      body.trim(),
      draft,
      closes,
    );
    setBusy(false);
    if (result) setCreating(false);
  }

  async function onToggleApprove() {
    if (!mr) return;
    setBusy(true);
    if (approval?.approved) {
      const ok = await unapproveMr(workspaceId, mr.number);
      if (ok) toastInfo(`Revoked approval on ${terms.ref(mr.number)}`);
    } else {
      const ok = await approveMr(workspaceId, mr.number);
      if (ok) toastSuccess(`Approved ${terms.ref(mr.number)}`);
    }
    setBusy(false);
  }

  async function onMerge() {
    if (!mr) return;
    // `ask`, not `window.confirm` — the dialog plugin makes the latter
    // async (always-truthy Promise), which skipped the guard.
    const confirmed = await ask(
      `Merge ${terms.ref(mr.number)} into its target branch (using the project's merge method)?` +
        (linkedIssue != null ? ` This closes #${linkedIssue} if the description says so.` : ""),
      { title: `Merge ${terms.mr}`, kind: "warning", okLabel: "Merge" },
    );
    if (!confirmed) return;
    setBusy(true);
    const ok = await mergeMr(workspaceId, branch, mr.number);
    setBusy(false);
    if (ok) toastSuccess(`Merged ${terms.ref(mr.number)}`);
  }

  return (
    <div className="shrink-0">
      <div className="flex h-8 items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-3 text-xs">
        <IssueChip workspaceId={workspaceId} worktreeId={worktreeId} branch={branch} />
        {mr === undefined ? (
          <span className="text-neutral-600">…</span>
        ) : mr === null ? (
          creating ? (
            <>
              <span className="flex-1" />
              <span className="text-neutral-500">Creating {terms.mr}</span>
            </>
          ) : (
            <>
              <span className="text-neutral-500">No {terms.mr} for this branch</span>
              <span className="flex-1" />
              <button
                onClick={startCreate}
                className="rounded border border-blue-700 bg-blue-950/40 px-2 py-0.5 font-medium text-blue-200 hover:bg-blue-950/60"
              >
                Create {terms.mr}
              </button>
            </>
          )
        ) : (
          <>
            <button
              onClick={() => void openExternalUrl(mr.url)}
              className="min-w-0 truncate text-left text-neutral-200 hover:underline"
              title={`Open ${terms.mr} in browser`}
            >
              <span className="font-mono text-neutral-400">{terms.ref(mr.number)}</span>{" "}
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
                {(approval?.approved || approval?.canApprove !== false) && (
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
                        : `Approve this ${terms.mr}`
                    }
                  >
                    {approval?.approved ? "Unapprove" : "Approve"}
                  </button>
                )}
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
      {creating && mr === null && (
        <div className="flex flex-col gap-2 border-b border-neutral-800 bg-neutral-950 px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <label htmlFor="mr-title" className="w-10 shrink-0 text-neutral-500">
              Title
            </label>
            <input
              id="mr-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder={`${terms.mr} title`}
              className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100 focus:border-neutral-500 focus:outline-none"
            />
          </div>
          <div className="flex gap-2">
            <label htmlFor="mr-body" className="w-10 shrink-0 pt-1 text-neutral-500">
              Body
            </label>
            <textarea
              id="mr-body"
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.metaKey) void confirmCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="Description (optional) — ⌘↵ to create"
              className="min-w-0 flex-1 resize-y rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-[11px] leading-relaxed text-neutral-100 focus:border-neutral-500 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-3 pl-12">
            {linkedIssue != null && (
              <label className="flex items-center gap-1.5 text-neutral-300">
                <input
                  type="checkbox"
                  checked={closes}
                  onChange={(e) => toggleCloses(e.target.checked)}
                  className="accent-blue-600"
                />
                Close #{linkedIssue} when merged
              </label>
            )}
            <label className="flex items-center gap-1.5 text-neutral-300">
              <input
                type="checkbox"
                checked={draft}
                onChange={(e) => setDraft(e.target.checked)}
                className="accent-blue-600"
              />
              Draft
            </label>
            <span className="flex-1" />
            {remote === null ? (
              <span className="text-neutral-500">Checking origin…</span>
            ) : needsPush ? (
              <>
                <span className="text-amber-300">
                  {remote === "missing" ? "Not on origin yet" : "Origin is behind this branch"}
                </span>
                <button
                  disabled={pushing}
                  onClick={() => void push()}
                  title={`git push -u origin ${branch}`}
                  className="rounded border border-amber-700 bg-amber-950/40 px-2 py-0.5 font-medium text-amber-200 hover:bg-amber-950/60 disabled:opacity-50"
                >
                  {pushing ? "Pushing…" : "Push"}
                </button>
              </>
            ) : remote === "matches" ? (
              <span className="text-neutral-500">Pushed</span>
            ) : null}
            <button
              onClick={() => setCreating(false)}
              className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-400 hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              disabled={!canCreate}
              title={needsPush ? "Push the branch first" : undefined}
              onClick={() => void confirmCreate()}
              className="rounded border border-blue-700 bg-blue-950/40 px-2 py-0.5 font-medium text-blue-200 hover:bg-blue-950/60 disabled:opacity-50"
            >
              {busy ? "Creating…" : `Create ${terms.mr}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/// `Closes #n`-style line helpers for the create form's checkbox, which
/// edits the body text rather than shadowing it.
function hasLine(body: string, line: string): boolean {
  return body.split("\n").some((l) => l.trim() === line);
}

function addLine(body: string, line: string): string {
  if (hasLine(body, line)) return body;
  return body.trim() ? `${line}\n\n${body.trimStart()}` : line;
}

function removeLine(body: string, line: string): string {
  return body
    .split("\n")
    .filter((l) => l.trim() !== line)
    .join("\n")
    .trim();
}

/// Human label for GitLab's `detailed_merge_status` when it blocks merging.
/// The GitHub provider translates `mergeStateStatus` into these same values.
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
    blocked: "blocked by branch rules",
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
