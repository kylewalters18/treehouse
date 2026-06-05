import { useEffect, useMemo, useState } from "react";
import type { WorkspaceId } from "@/ipc/types";
import { listBranches, openExternalUrl } from "@/ipc/client";
import { useForgeStore, type ForgeIssueState } from "@/stores/forge";
import { useWorkspaceStore } from "@/stores/workspace";
import { cn } from "@/lib/cn";

/// The single worktree-creation surface: browse/search issues (rich list with
/// labels, assignee, state filter, open-in-browser) up top, and the create
/// fields (branch name, fork-from base, options) pinned below. Picking an issue
/// fills the branch name with `<n>-<slug>`; the `Closes #n` link rides along in
/// the name. Leave the list alone and just type a name for a local branch.
///
/// `onCreate` runs the actual create (with progress) in the parent; this dialog
/// is the input collector + issue browser.
export function NewWorktreeDialog({
  workspaceId,
  open,
  defaultInitSubmodules,
  onCreate,
  onClose,
}: {
  workspaceId: WorkspaceId | null;
  open: boolean;
  defaultInitSubmodules: boolean;
  onCreate: (
    name: string,
    base: string | null,
    opts: { initSubmodules: boolean; runSetup: boolean },
  ) => void;
  onClose: () => void;
}) {
  const issues = useForgeStore((s) => s.issues);
  const loading = useForgeStore((s) => s.issuesLoading);
  const loadIssues = useForgeStore((s) => s.loadIssues);
  const loadStatus = useForgeStore((s) => s.loadStatus);
  const status = useForgeStore((s) =>
    workspaceId ? s.status[workspaceId] : undefined,
  );
  const defaultBranch = useWorkspaceStore((s) =>
    workspaceId ? s.workspaces.find((w) => w.id === workspaceId)?.defaultBranch : undefined,
  );

  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<ForgeIssueState>("open");
  const [branchName, setBranchName] = useState("");
  const [base, setBase] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [initSubmodules, setInitSubmodules] = useState(defaultInitSubmodules);
  const [runSetup, setRunSetup] = useState(true);
  const [showOptions, setShowOptions] = useState(false);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setStateFilter("open");
    setBranchName("");
    setBase(null);
    setInitSubmodules(defaultInitSubmodules);
    setRunSetup(true);
    setShowOptions(false);
  }, [open, defaultInitSubmodules]);

  useEffect(() => {
    if (!open || !workspaceId) return;
    void loadStatus(workspaceId);
    listBranches(workspaceId).then(setBranches).catch(() => {});
  }, [open, workspaceId, loadStatus]);

  useEffect(() => {
    if (!open || !workspaceId) return;
    const id = setTimeout(() => {
      void loadIssues(workspaceId, query, stateFilter);
    }, 250);
    return () => clearTimeout(id);
  }, [open, workspaceId, query, stateFilter, loadIssues]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Base picker default: origin/<default> if present, else local default.
  const origin = defaultBranch ? `origin/${defaultBranch}` : "";
  const preferredBase = branches.includes(origin)
    ? origin
    : defaultBranch && branches.includes(defaultBranch)
      ? defaultBranch
      : origin;
  const currentBase = base ?? preferredBase;
  const baseOptions = useMemo(() => {
    const opts = branches.length ? branches : [preferredBase].filter(Boolean);
    return opts.includes(currentBase) ? opts : [currentBase, ...opts].filter(Boolean);
  }, [branches, currentBase, preferredBase]);

  // The issue this branch will close, derived from a leading `<n>-` prefix.
  const linkedIssue = useMemo(() => {
    const m = branchName.match(/^(\d+)-/);
    return m ? m[1] : null;
  }, [branchName]);

  // Auth hint when issues can't load (no token / invalid). netrc for GitLab.
  const authHint =
    !status || status.authenticated
      ? null
      : status.kind === "gitlab"
        ? status.installed
          ? "GitLab token invalid or expired."
          : `No GitLab token — add one for ${status.host ?? "this host"} in ~/.netrc.`
        : status.installed
          ? "Not signed in — run gh auth login."
          : "gh is not installed.";

  if (!open || !workspaceId) return null;

  function pickIssue(number: number, title: string) {
    setBranchName(`${number}-${slugify(title).slice(0, 50)}`);
  }

  function submit() {
    const name = branchName.trim();
    if (!name) return;
    onCreate(name, base, { initSubmodules, runSetup });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[8vh]"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[42rem] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Issue browser */}
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

        {authHint && (
          <div className="border-b border-amber-900/50 bg-amber-950/30 px-3 py-1.5 text-[12px] text-amber-200">
            {authHint}
          </div>
        )}

        <div className="min-h-[6rem] flex-1 overflow-y-auto">
          {loading && issues.length === 0 ? (
            <div className="p-4 text-sm text-neutral-500">Loading…</div>
          ) : issues.length === 0 ? (
            <div className="p-4 text-sm text-neutral-500">
              No issues — type a branch name below for a local branch.
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-800/70">
              {issues.map((issue) => {
                const selected = linkedIssue === String(issue.number);
                return (
                  <li key={issue.number}>
                    <div
                      onClick={() => pickIssue(issue.number, issue.title)}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-neutral-950/60",
                        selected && "bg-blue-950/30",
                      )}
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
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void openExternalUrl(issue.url);
                        }}
                        className="rounded border border-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
                        title="Open in browser"
                      >
                        ↗
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Create form */}
        <div className="flex flex-col gap-2 border-t border-neutral-800 bg-neutral-950/40 p-3">
          <label className="flex items-center gap-2 text-xs">
            <span className="w-20 shrink-0 text-neutral-500">Branch name</span>
            <input
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="my-branch  (or pick an issue above)"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            />
            {linkedIssue && (
              <span className="shrink-0 rounded bg-emerald-950/40 px-1.5 py-[1px] text-[10px] text-emerald-300">
                🔗 closes #{linkedIssue}
              </span>
            )}
          </label>

          <label className="flex items-center gap-2 text-xs">
            <span className="w-20 shrink-0 text-neutral-500">Base</span>
            <select
              value={currentBase}
              onChange={(e) => setBase(e.target.value)}
              className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 focus:border-neutral-600 focus:outline-none"
            >
              {baseOptions.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>

          <div>
            <button
              onClick={() => setShowOptions((v) => !v)}
              className="text-[11px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300"
            >
              {showOptions ? "▾" : "▸"} Options
            </button>
            {showOptions && (
              <div className="mt-1.5 flex flex-col gap-1 pl-2">
                <label className="flex items-center gap-2 text-xs text-neutral-300">
                  <input
                    type="checkbox"
                    checked={initSubmodules}
                    onChange={(e) => setInitSubmodules(e.target.checked)}
                    className="accent-blue-600"
                  />
                  Initialize submodules
                </label>
                <label className="flex items-center gap-2 text-xs text-neutral-300">
                  <input
                    type="checkbox"
                    checked={runSetup}
                    onChange={(e) => setRunSetup(e.target.checked)}
                    className="accent-blue-600"
                  />
                  Run setup hook after create
                </label>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!branchName.trim()}
              className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/// Mirror of the backend `git_ops::slugify`: lowercase, ASCII alphanumerics
/// kept, every other run collapsed to a single dash, trimmed. So the branch
/// field shows the real name and the `<n>-` prefix matches an issue.
function slugify(name: string): string {
  let s = "";
  let prevDash = true;
  for (const c of name) {
    const ch = c.toLowerCase();
    if (/[a-z0-9]/.test(ch)) {
      s += ch;
      prevDash = false;
    } else if (!prevDash) {
      s += "-";
      prevDash = true;
    }
  }
  return s.replace(/^-+|-+$/g, "") || "wt";
}
