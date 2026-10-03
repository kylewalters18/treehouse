import { useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { ForgeIssue, IssueStart, WorkspaceId } from "@/ipc/types";
import {
  forgeCreateIssue,
  forgeGetIssue,
  forgeUpdateIssue,
  listBranches,
  openExternalUrl,
} from "@/ipc/client";
import { useForgeStore, type ForgeIssueState } from "@/stores/forge";
import { useWorkspaceStore } from "@/stores/workspace";
import { toastError } from "@/stores/toasts";
import { asMessage, errorKind } from "@/lib/errors";
import { cn } from "@/lib/cn";

export type NewWorktreeOptions = {
  initSubmodules: boolean;
  runSetup: boolean;
  /// Start the default agent. With `issue`, Rust seeds it with the issue.
  startAgent: boolean;
  /// Set when creating from an issue (already filed / saved by the dialog).
  issue?: IssueStart;
};

/// Title + description being edited for one row: an existing issue (keyed
/// by number) or the "New issue" row (keyed "new").
type Draft = { title: string; body: string };
type RowKey = number | "new";

/// The single worktree-creation surface, palette-style: one field that both
/// searches issues and names a new branch. Typing offers "New branch <slug>"
/// (the default row — type-and-Enter always makes a plain branch) and "New
/// issue", with matching issues below.
///
/// Picking an issue opens its title/description in the footer. Edits are
/// saved back to the forge on Create (with a changed-since check), a new
/// issue is filed on Create, and only then does the worktree get made — so a
/// failed save leaves nothing behind and keeps the dialog open. Drafts are
/// kept per row while browsing; closing with unsaved edits asks first.
///
/// `onCreate` runs the actual create (with progress) in the parent.
export function NewWorktreeDialog({
  workspaceId,
  open,
  defaultInitSubmodules,
  defaultStartAgent,
  onCreate,
  onClose,
}: {
  workspaceId: WorkspaceId | null;
  open: boolean;
  defaultInitSubmodules: boolean;
  defaultStartAgent: boolean;
  onCreate: (name: string, base: string | null, opts: NewWorktreeOptions) => void;
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
  /// Index into the rows; -1 = nothing selected (empty query).
  const [sel, setSel] = useState(-1);
  /// Hand-edited branch name; null = derive from the selection.
  const [branchEdit, setBranchEdit] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [initSubmodules, setInitSubmodules] = useState(defaultInitSubmodules);
  const [runSetup, setRunSetup] = useState(true);
  const [startAgent, setStartAgent] = useState(defaultStartAgent);
  const [seedAgent, setSeedAgent] = useState(true);
  const [assign, setAssign] = useState(true);
  const [link, setLink] = useState(true);
  const [showOptions, setShowOptions] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<RowKey, Draft>>>({});
  /// Newer copies of issues (after "Use theirs") that override the list's.
  const [fresh, setFresh] = useState<Record<number, ForgeIssue>>({});
  const [conflict, setConflict] = useState<ForgeIssue | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const forgeReady = !!status?.authenticated;
  const forgeName = status?.kind === "github" ? "GitHub" : "GitLab";

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setStateFilter("open");
    setSel(-1);
    setBranchEdit(null);
    setBase(null);
    setInitSubmodules(defaultInitSubmodules);
    setStartAgent(defaultStartAgent);
    setSeedAgent(true);
    setAssign(true);
    setLink(true);
    setRunSetup(true);
    setShowOptions(false);
    setDrafts({});
    setFresh({});
    setConflict(null);
    setBusy(false);
  }, [open, defaultInitSubmodules, defaultStartAgent]);

  useEffect(() => {
    if (!open || !workspaceId) return;
    void loadStatus(workspaceId);
    listBranches(workspaceId).then(setBranches).catch(() => {});
  }, [open, workspaceId, loadStatus]);

  // Only query the forge once it's known to be reachable — otherwise every
  // keystroke would toast an auth error; the hint banner covers that case.
  useEffect(() => {
    if (!open || !workspaceId || !forgeReady) return;
    const id = setTimeout(() => {
      void loadIssues(workspaceId, query, stateFilter);
    }, 250);
    return () => clearTimeout(id);
  }, [open, workspaceId, forgeReady, query, stateFilter, loadIssues]);

  const trimmed = query.trim();
  const plainSlug = trimmed ? slugify(trimmed) : "";
  const shownIssues = forgeReady ? issues.map((i) => fresh[i.number] ?? i) : [];
  // Rows: "New branch" and "New issue" whenever there's text, then issues.
  const plainRow = trimmed ? 0 : -1;
  const newRow = trimmed && forgeReady ? 1 : -1;
  const offset = (trimmed ? 1 : 0) + (newRow >= 0 ? 1 : 0);
  const rowCount = shownIssues.length + offset;
  const selIssue: ForgeIssue | null =
    sel >= offset && sel < rowCount ? shownIssues[sel - offset] : null;
  const plainSelected = sel === plainRow && plainRow >= 0;
  const newSelected = sel === newRow && newRow >= 0;
  const key: RowKey | null = selIssue ? selIssue.number : newSelected ? "new" : null;

  // The editor's current values for the selected row.
  const draft: Draft | null = selIssue
    ? (drafts[selIssue.number] ?? { title: selIssue.title, body: selIssue.body })
    : newSelected
      ? (drafts.new ?? { title: trimmed, body: "" })
      : null;
  const edited =
    !!selIssue && !!draft && (draft.title !== selIssue.title || draft.body !== selIssue.body);

  function isDirty(k: RowKey): boolean {
    const d = drafts[k];
    if (!d) return false;
    if (k === "new") return d.body.trim() !== "" || (d.title.trim() !== "" && d.title !== trimmed);
    const i = shownIssues.find((x) => x.number === k);
    return !!i && (d.title !== i.title || d.body !== i.body);
  }
  const anyDirty = (Object.keys(drafts) as string[]).some((k) =>
    isDirty(k === "new" ? "new" : Number(k)),
  );

  function setDraft(patch: Partial<Draft>) {
    if (key == null || !draft) return;
    setDrafts((d) => ({ ...d, [key]: { ...draft, ...patch } }));
  }

  function revert() {
    if (key == null) return;
    setDrafts((d) => {
      const { [key]: _, ...rest } = d;
      return rest;
    });
  }

  /// Close, asking first when there are unsaved issue edits.
  async function requestClose() {
    if (busy) return;
    if (anyDirty) {
      const ok = await ask("Discard your unsaved issue edits?", {
        title: "Discard edits",
        kind: "warning",
        okLabel: "Discard",
      });
      if (!ok) return;
    }
    onClose();
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") void requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Typing re-anchors on the "New branch" row; clearing drops the selection.
  function onQuery(v: string) {
    setQuery(v);
    setSel(v.trim() ? 0 : -1);
    setBranchEdit(null);
    setConflict(null);
  }

  function select(i: number) {
    setSel(i);
    setBranchEdit(null);
    setConflict(null);
  }

  // Keep the keyboard selection in view.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

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

  const issueBranch = (n: number | string, title: string) =>
    `${n}-${slugify(title).slice(0, 50)}`;
  const derivedBranch = selIssue
    ? issueBranch(selIssue.number, draft?.title ?? selIssue.title)
    : plainSelected
      ? plainSlug
      : "";
  // A new issue's number isn't known until it's filed: show the shape.
  const branchPlaceholder = newSelected
    ? issueBranch("<n>", draft?.title ?? trimmed)
    : "type above, or pick an issue";
  const branchName = branchEdit ?? derivedBranch;
  const canCreate = newSelected
    ? !!draft?.title.trim()
    : !!branchName.trim() && (!selIssue || !!draft?.title.trim());

  // Auth hint when issues can't load (no token / invalid). netrc for GitLab.
  const authHint =
    !status || status.authenticated || status.kind === "unknown"
      ? null
      : status.kind === "gitlab"
        ? status.installed
          ? "GitLab token invalid or expired."
          : `No GitLab token — add one for ${status.host ?? "this host"} in ~/.netrc.`
        : status.installed
          ? "Not signed in — run gh auth login."
          : "gh is not installed.";

  if (!open || !workspaceId) return null;
  const ws = workspaceId;

  /// Save the issue side first (file the new issue / write edits), then hand
  /// off the worktree create. Any failure keeps the dialog open with the
  /// user's text; a `Conflict` shows the newer version instead.
  async function submit(overwrite = false) {
    if (!canCreate || busy) return;
    const common = { initSubmodules, runSetup };
    if (!selIssue && !newSelected) {
      onCreate(branchName.trim(), base, { ...common, startAgent });
      onClose();
      return;
    }
    setBusy(true);
    try {
      let issue: ForgeIssue;
      if (newSelected && draft) {
        issue = await forgeCreateIssue(ws, draft.title.trim(), draft.body);
      } else if (selIssue && draft && edited) {
        issue = await forgeUpdateIssue(
          ws,
          selIssue.number,
          draft.title.trim(),
          draft.body,
          overwrite ? null : selIssue.updatedAt,
        );
      } else {
        issue = selIssue as ForgeIssue;
      }
      const name = branchEdit?.trim() || issueBranch(issue.number, issue.title);
      onCreate(name, base, {
        ...common,
        startAgent: seedAgent,
        issue: { number: issue.number, assign, link },
      });
      onClose();
    } catch (e) {
      if (errorKind(e) === "Conflict" && selIssue) {
        try {
          setConflict(await forgeGetIssue(ws, selIssue.number));
        } catch (e2) {
          toastError(`#${selIssue.number} changed and couldn't be re-read`, asMessage(e2));
        }
      } else {
        toastError(
          newSelected ? "Couldn't file the issue" : `Couldn't update #${selIssue?.number}`,
          asMessage(e),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  /// Conflict → take the forge's current version; the user's edits go.
  function takeTheirs() {
    if (!conflict) return;
    setFresh((f) => ({ ...f, [conflict.number]: conflict }));
    setDrafts((d) => {
      const { [conflict.number]: _, ...rest } = d;
      return rest;
    });
    setConflict(null);
  }

  function onQueryKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rowCount > 0) select(Math.min(sel + 1, rowCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rowCount > 0) select(Math.max(sel - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  }

  const checkbox = "accent-blue-600";
  const optionLabel = "flex items-center gap-2 text-xs text-neutral-300";
  const fieldLabel = "w-20 shrink-0 text-neutral-500";
  const rowBase = "flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-neutral-950/60";
  const rowSelected = "bg-blue-950/30 shadow-[inset_2px_0_0_theme(colors.blue.500)]";
  const cta = busy
    ? "Saving…"
    : newSelected
      ? "File issue & create"
      : selIssue
        ? edited
          ? `Update #${selIssue.number} & create`
          : `Create from #${selIssue.number}`
        : "Create";

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[6vh]"
      onMouseDown={() => void requestClose()}
    >
      <div
        className="flex max-h-[86vh] w-[42rem] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-neutral-800 p-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onQueryKey}
            placeholder={
              forgeReady ? "Search issues, or type a new branch name…" : "New branch name…"
            }
            aria-label="Search issues or name a new branch"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
          {forgeReady && (
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value as ForgeIssueState)}
              aria-label="Issue state"
              className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-300"
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
          )}
        </div>

        {authHint && (
          <div className="border-b border-amber-900/50 bg-amber-950/30 px-3 py-1.5 text-[12px] text-amber-200">
            {authHint}
          </div>
        )}

        <div ref={listRef} className="min-h-[5rem] flex-1 overflow-y-auto py-1">
          {plainRow >= 0 && (
            <button
              data-row={plainRow}
              onClick={() => select(plainRow)}
              onDoubleClick={() => void submit()}
              className={cn(rowBase, plainSelected && rowSelected)}
            >
              <span className="w-8 text-right text-neutral-500">⎇</span>
              <span className="min-w-0 flex-1 truncate text-neutral-300">
                New branch <span className="font-mono text-neutral-100">{plainSlug}</span>
                <span className="text-neutral-500"> — no issue</span>
              </span>
            </button>
          )}
          {newRow >= 0 && (
            <button
              data-row={newRow}
              onClick={() => select(newRow)}
              className={cn(rowBase, newSelected && rowSelected)}
            >
              <span className="w-8 text-right text-neutral-500">+</span>
              <span className="min-w-0 flex-1 truncate text-neutral-300">
                New issue <span className="text-neutral-100">“{trimmed}”</span>
                {isDirty("new") && <span className="text-amber-300"> · draft</span>}
              </span>
            </button>
          )}

          {forgeReady && trimmed && shownIssues.length > 0 && (
            <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-neutral-500">
              Issues
            </div>
          )}

          {forgeReady && loading && shownIssues.length === 0 ? (
            <div className="p-4 text-sm text-neutral-500">Loading issues…</div>
          ) : forgeReady && shownIssues.length === 0 ? (
            <div className="p-4 text-sm text-neutral-500">
              {trimmed ? "No matching issues." : "No issues. Type a name for a new branch or issue."}
            </div>
          ) : !forgeReady && !trimmed ? (
            <div className="p-4 text-sm text-neutral-500">Type a name for a new branch.</div>
          ) : (
            <ul className="flex flex-col">
              {shownIssues.map((issue, i) => {
                const row = i + offset;
                const selected = row === sel;
                return (
                  <li key={issue.number}>
                    <div
                      data-row={row}
                      onClick={() => select(row)}
                      onDoubleClick={() => void submit()}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-neutral-950/60",
                        selected && rowSelected,
                      )}
                    >
                      <span className="mt-0.5 w-8 text-right font-mono text-[11px] text-neutral-500">
                        #{issue.number}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-neutral-100">
                          {issue.title}
                          {isDirty(issue.number) && (
                            <span className="text-xs text-amber-300"> · edited</span>
                          )}
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

        {/* Create form — follows the selection */}
        <div className="flex flex-col gap-2 border-t border-neutral-800 bg-neutral-950/40 p-3">
          {draft && (
            <>
              <div className="flex min-h-[1.25rem] items-center gap-2 text-[11px]">
                <span className="uppercase tracking-wider text-neutral-500">
                  {selIssue ? `Issue #${selIssue.number}` : "New issue"}
                </span>
                {newSelected ? (
                  <span className="rounded bg-blue-950/50 px-1.5 text-blue-300">
                    filed on {forgeName} when you create
                  </span>
                ) : edited ? (
                  <>
                    <span className="rounded bg-amber-950/60 px-1.5 text-amber-300">
                      edited — will update #{selIssue?.number} on {forgeName}
                    </span>
                    <button
                      onClick={revert}
                      className="text-neutral-400 underline hover:text-neutral-200"
                    >
                      Revert
                    </button>
                  </>
                ) : (
                  <span className="text-neutral-600">edit to update the issue before starting</span>
                )}
                <span className="flex-1" />
                {selIssue && (
                  <button
                    onClick={() => void openExternalUrl(selIssue.url)}
                    className="text-blue-300 hover:text-blue-200"
                  >
                    Open on {forgeName} ↗
                  </button>
                )}
              </div>

              {conflict && (
                <div
                  role="alert"
                  className="flex flex-col gap-2 rounded border border-orange-900 bg-orange-950/30 p-2 text-xs"
                >
                  <div className="font-medium text-orange-200">
                    #{conflict.number} changed on {forgeName} since you opened it — nothing was
                    saved or created.
                  </div>
                  <div className="text-orange-200/80">Their version:</div>
                  <div className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded border border-orange-950 bg-neutral-950 p-2 font-mono text-[11px] text-neutral-200">
                    <div className="font-sans font-medium">{conflict.title}</div>
                    {conflict.body || <span className="text-neutral-500">No description.</span>}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={takeTheirs}
                      className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-neutral-100 hover:bg-neutral-700"
                    >
                      Use theirs (drop my edits)
                    </button>
                    <button
                      onClick={() => {
                        setConflict(null);
                        void submit(true);
                      }}
                      className="rounded border border-red-900 px-2 py-1 text-red-300 hover:bg-red-950/40"
                    >
                      Overwrite with mine
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 text-xs">
                <label htmlFor="nwt-title" className={fieldLabel}>
                  Title
                </label>
                <input
                  id="nwt-title"
                  value={draft.title}
                  onChange={(e) => setDraft({ title: e.target.value })}
                  className={cn(
                    "min-w-0 flex-1 rounded border bg-neutral-950 px-2 py-1 text-sm text-neutral-100 focus:outline-none",
                    selIssue && draft.title !== selIssue.title
                      ? "border-amber-700"
                      : "border-neutral-800 focus:border-neutral-600",
                  )}
                />
              </div>
              <div className="flex gap-2 text-xs">
                <label htmlFor="nwt-body" className={cn(fieldLabel, "pt-1")}>
                  Description
                </label>
                <textarea
                  id="nwt-body"
                  rows={5}
                  value={draft.body}
                  onChange={(e) => setDraft({ body: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.metaKey) void submit();
                  }}
                  placeholder={
                    newSelected ? "What should change, and how will you know it's done?" : ""
                  }
                  className={cn(
                    "min-w-0 flex-1 resize-y rounded border bg-neutral-950 px-2 py-1 font-mono text-[11px] leading-relaxed text-neutral-100 placeholder:font-sans placeholder:text-neutral-600 focus:outline-none",
                    selIssue && draft.body !== selIssue.body
                      ? "border-amber-700"
                      : "border-neutral-800 focus:border-neutral-600",
                  )}
                />
              </div>
            </>
          )}

          <div className="flex items-center gap-2 text-xs">
            <label htmlFor="nwt-branch" className={fieldLabel}>
              Branch
            </label>
            <input
              id="nwt-branch"
              value={branchName}
              onChange={(e) => setBranchEdit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              placeholder={branchPlaceholder}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            />
            <label htmlFor="nwt-base" className="shrink-0 text-neutral-500">
              from
            </label>
            <select
              id="nwt-base"
              value={currentBase}
              onChange={(e) => setBase(e.target.value)}
              className="w-40 min-w-0 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 focus:border-neutral-600 focus:outline-none"
            >
              {baseOptions.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 pl-[5.5rem]">
            {draft ? (
              <>
                <label className={optionLabel}>
                  <input
                    type="checkbox"
                    checked={seedAgent}
                    onChange={(e) => setSeedAgent(e.target.checked)}
                    className={checkbox}
                  />
                  Start agent with the issue as its first prompt
                </label>
                <label className={optionLabel}>
                  <input
                    type="checkbox"
                    checked={assign}
                    onChange={(e) => setAssign(e.target.checked)}
                    className={checkbox}
                  />
                  Assign to me
                </label>
                <label className={optionLabel}>
                  <input
                    type="checkbox"
                    checked={link}
                    onChange={(e) => setLink(e.target.checked)}
                    className={checkbox}
                  />
                  Link — PR closes it
                </label>
              </>
            ) : (
              <label className={optionLabel}>
                <input
                  type="checkbox"
                  checked={startAgent}
                  onChange={(e) => setStartAgent(e.target.checked)}
                  className={checkbox}
                />
                Start default agent
              </label>
            )}
          </div>

          {showOptions && (
            <div className="flex flex-col gap-1 pl-[5.5rem]">
              <label className={optionLabel}>
                <input
                  type="checkbox"
                  checked={initSubmodules}
                  onChange={(e) => setInitSubmodules(e.target.checked)}
                  className={checkbox}
                />
                Initialize submodules
              </label>
              <label className={optionLabel}>
                <input
                  type="checkbox"
                  checked={runSetup}
                  onChange={(e) => setRunSetup(e.target.checked)}
                  className={checkbox}
                />
                Run setup hook after create
              </label>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowOptions((v) => !v)}
              className="text-[11px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300"
            >
              {showOptions ? "▾" : "▸"} Options
            </button>
            <span className="flex-1" />
            <span className="text-[11px] text-neutral-600">↑↓ choose · ↵ create · esc close</span>
            <button
              onClick={() => void requestClose()}
              className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={!canCreate || busy || !!conflict}
              className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {cta}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/// Mirror of the backend `git_ops::slugify`: lowercase, ASCII alphanumerics
/// kept, every other run collapsed to a single dash, trimmed. So the branch
/// field shows the real name the worktree will get.
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
