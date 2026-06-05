import { useEffect, useMemo, useState } from "react";
import type { WorkspaceId } from "@/ipc/types";
import { listBranches, openExternalUrl } from "@/ipc/client";
import { useForgeStore, type ForgeIssueState } from "@/stores/forge";
import { useWorktreesStore } from "@/stores/worktrees";
import { useWorkspaceStore } from "@/stores/workspace";
import { useUiStore } from "@/stores/ui";
import { toastSuccess } from "@/stores/toasts";
import { cn } from "@/lib/cn";

/// Modal issue browser — search the forge's issues and spin a worktree off
/// one in a click. Same overlay pattern as FileFinder / CommandPalette; the
/// owning Workspace controls `open`. Scoped to a single workspace at a time.
export function IssuesPanel({
  workspaceId,
  open,
  onClose,
}: {
  workspaceId: WorkspaceId | null;
  open: boolean;
  onClose: () => void;
}) {
  const issues = useForgeStore((s) => s.issues);
  const loading = useForgeStore((s) => s.issuesLoading);
  const loadIssues = useForgeStore((s) => s.loadIssues);
  const status = useForgeStore((s) =>
    workspaceId ? s.status[workspaceId] : undefined,
  );
  const loadStatus = useForgeStore((s) => s.loadStatus);
  const createFromIssue = useWorktreesStore((s) => s.createFromIssue);
  const creating = useWorktreesStore((s) => s.creating);
  const selectWorktree = useUiStore((s) => s.selectWorktree);
  const defaultBranch = useWorkspaceStore((s) =>
    workspaceId ? s.workspaces.find((w) => w.id === workspaceId)?.defaultBranch : undefined,
  );

  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<ForgeIssueState>("open");
  // Branch the created worktree forks from (null → origin/<default>).
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState<string | null>(null);

  // Load status + issues on open, and debounce subsequent searches.
  useEffect(() => {
    if (!open || !workspaceId) return;
    void loadStatus(workspaceId);
  }, [open, workspaceId, loadStatus]);

  useEffect(() => {
    if (!open || !workspaceId) return;
    const id = setTimeout(() => {
      void loadIssues(workspaceId, query, stateFilter);
    }, 250);
    return () => clearTimeout(id);
  }, [open, workspaceId, query, stateFilter, loadIssues]);

  useEffect(() => {
    if (!open || !workspaceId) return;
    listBranches(workspaceId).then(setBranches).catch(() => {});
  }, [open, workspaceId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const origin = defaultBranch ? `origin/${defaultBranch}` : "";
  const preferredBase = branches.includes(origin)
    ? origin
    : defaultBranch && branches.includes(defaultBranch)
      ? defaultBranch
      : origin;
  const currentBase = base ?? preferredBase;
  const baseOptions = (branches.length ? branches : [preferredBase]).filter(Boolean);

  const unauthed = useMemo(
    () => status && status.installed && !status.authenticated,
    [status],
  );
  const notInstalled = status && !status.installed;

  if (!open) return null;

  async function onNewWorktree(number: number) {
    if (!workspaceId) return;
    const wt = await createFromIssue(workspaceId, number, base);
    if (wt) {
      selectWorktree(wt.id);
      toastSuccess(`Created ${wt.branch}`, "Worktree ready.");
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[10vh]"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[72vh] w-[40rem] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-neutral-800 p-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search issues…"
            className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as ForgeIssueState)}
            className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-300"
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </div>

        <label className="flex items-center gap-1.5 border-b border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-500">
          <span className="shrink-0">New worktrees fork from</span>
          <select
            value={currentBase}
            onChange={(e) => setBase(e.target.value)}
            className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-950 px-1.5 py-0.5 text-[11px] text-neutral-300 focus:border-neutral-700 focus:outline-none"
            title="Branch the created worktree forks from (and the MR targets)"
          >
            {(baseOptions.includes(currentBase)
              ? baseOptions
              : [currentBase, ...baseOptions]
            ).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>

        {(unauthed || notInstalled) && (
          <div className="border-b border-amber-900/50 bg-amber-950/30 px-3 py-2 text-[12px] text-amber-200">
            {notInstalled
              ? "glab is not installed — install it to browse issues."
              : "Not signed in — run "}
            {!notInstalled && <code className="font-mono">glab auth login</code>}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {loading && issues.length === 0 ? (
            <div className="p-4 text-sm text-neutral-500">Loading…</div>
          ) : issues.length === 0 ? (
            <div className="p-4 text-sm text-neutral-500">No issues match.</div>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-800">
              {issues.map((issue) => (
                <li
                  key={issue.number}
                  className="flex items-start gap-3 px-3 py-2 hover:bg-neutral-950/60"
                >
                  <span className="mt-0.5 font-mono text-[11px] text-neutral-500">
                    #{issue.number}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-neutral-100">
                      {issue.title}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      {issue.labels.slice(0, 4).map((l) => (
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
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      disabled={creating}
                      onClick={() => void onNewWorktree(issue.number)}
                      className={cn(
                        "rounded border border-blue-700 bg-blue-950/40 px-2 py-1 text-[11px] font-medium text-blue-200 hover:bg-blue-950/60",
                        creating && "cursor-not-allowed opacity-50",
                      )}
                      title="Create a worktree + branch from this issue"
                    >
                      + Worktree
                    </button>
                    <button
                      onClick={() => void openExternalUrl(issue.url)}
                      className="rounded border border-neutral-800 px-1.5 py-1 text-[11px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
                      title="Open in browser"
                    >
                      ↗
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
