/// The ⌘J planner's issue drawer: the repo's issues beside the conversation,
/// filterable by text, label and assignee. Clicking one opens its detail
/// (rendered description, labels, assignees) in the drawer; from there it can
/// be inserted into the planner's prompt as `#n Title`, or started as a
/// worktree (via the New Worktree dialog, preselected) — or, when a worktree
/// already works on it, jumped to. The list stays mounted underneath so its
/// scroll position survives going back.
///
/// The title and description can be edited in place. Saving checks the
/// issue hasn't changed on the forge since editing began (a teammate, or an
/// agent via MCP `update_issue`) and offers "use theirs" / "overwrite" when
/// it has. "New issue" files one from the drawer. Agent creates and edits
/// arrive as `issues-changed` and refresh the drawer.

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, Pencil, Plus } from "lucide-react";

import {
  forgeCreateIssue,
  forgeGetIssue,
  forgeListIssues,
  forgeUpdateIssue,
  onIssuesChanged,
  openExternalUrl,
} from "@/ipc/client";
import type { ForgeIssue, WorkspaceId, Worktree } from "@/ipc/types";
import { cn } from "@/lib/cn";
import { asMessage, errorKind } from "@/lib/errors";
import { formatWhen, relativeTime } from "@/lib/time";
import { useIssueLinksStore } from "@/stores/issueLinks";
import { toastError } from "@/stores/toasts";
import { useWorktreesStore } from "@/stores/worktrees";
import { Avatar } from "./Avatar";
import { ForgeMarkdown } from "./ForgeMarkdown";
import { IssueStateBadge, LabelPill } from "./IssueChip";

const LIMIT = 50;

type Assignee = "" | "none" | "@me";
type IssueState = "open" | "closed" | "all";

export function PlannerIssues({
  workspaceId,
  onInsert,
  onStart,
  onOpenWorktree,
}: {
  workspaceId: WorkspaceId;
  onInsert: (issue: ForgeIssue) => void;
  onStart: (issue: ForgeIssue) => void;
  onOpenWorktree: (wt: Worktree) => void;
}) {
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<IssueState>("open");
  const [labels, setLabels] = useState<string[]>([]);
  const [assignee, setAssignee] = useState<Assignee>("");
  const [issues, setIssues] = useState<ForgeIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /// The issue whose detail is showing; null = the list.
  const [detail, setDetail] = useState<ForgeIssue | null>(null);
  /// The "New issue" form is showing.
  const [creating, setCreating] = useState(false);
  /// Bumped to re-run the list query (an agent edited an issue).
  const [reload, setReload] = useState(0);

  const linksByPath = useIssueLinksStore((s) => s.byPath);
  const loadLinks = useIssueLinksStore((s) => s.load);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  useEffect(() => void loadLinks(), [loadLinks]);

  /// Issue number → the worktree already working on it.
  const worktreeFor = useMemo(() => {
    const out = new Map<number, Worktree>();
    for (const wt of worktrees) {
      const n = wt.workspaceId === workspaceId ? linksByPath[wt.path] : undefined;
      if (n != null) out.set(n, wt);
    }
    return out;
  }, [worktrees, linksByPath, workspaceId]);

  /// Show an issue's detail, then swap in a fresh copy — the list's may be
  /// minutes old, and editing starts from what's shown.
  function openDetail(issue: ForgeIssue) {
    setDetail(issue);
    forgeGetIssue(workspaceId, issue.number)
      .then((fresh) => setDetail((cur) => (cur?.number === fresh.number ? fresh : cur)))
      .catch(() => {});
  }

  /// A newer copy of one issue (saved here, or re-read) → detail + list.
  function applyIssue(issue: ForgeIssue) {
    setDetail((cur) => (cur?.number === issue.number ? issue : cur));
    setIssues((list) => list?.map((i) => (i.number === issue.number ? issue : i)) ?? list);
  }

  useEffect(() => {
    const unlisten = onIssuesChanged(workspaceId, (n) => {
      setReload((r) => r + 1);
      forgeGetIssue(workspaceId, n)
        .then((fresh) => setDetail((cur) => (cur?.number === n ? fresh : cur)))
        .catch(() => {});
    });
    return () => void unlisten.then((f) => f());
  }, [workspaceId]);

  const labelKey = labels.join("\n");
  useEffect(() => {
    let live = true;
    const id = setTimeout(() => {
      forgeListIssues(workspaceId, query, stateFilter, LIMIT, {
        labels: labelKey ? labelKey.split("\n") : [],
        assignee: assignee || undefined,
      })
        .then((list) => {
          if (!live) return;
          setIssues(list);
          setError(null);
        })
        .catch((e) => {
          if (!live) return;
          setIssues([]);
          setError(asMessage(e));
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [workspaceId, query, stateFilter, labelKey, assignee, reload]);

  const addLabel = (l: string) => setLabels((ls) => (ls.includes(l) ? ls : [...ls, l]));
  const toggleAssignee = (a: Assignee) => setAssignee((cur) => (cur === a ? "" : a));

  return (
    <aside
      aria-label="Issues"
      className="relative flex w-[380px] shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/60"
    >
      <div className="flex flex-col gap-2 border-b border-neutral-800 p-2.5">
        <div className="flex gap-1.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search issues"
            aria-label="Search issues"
            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
          <button
            onClick={() => setCreating(true)}
            title="File a new issue"
            className="flex shrink-0 items-center gap-1 rounded border border-neutral-700 px-2 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            <Plus size={12} /> New issue
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {labels.map((l) => (
            <button
              key={l}
              onClick={() => setLabels((ls) => ls.filter((x) => x !== l))}
              title="Remove filter"
              className="rounded-full border border-blue-500/50 px-2 py-px text-blue-300 hover:bg-blue-950/40"
            >
              label: {l} ✕
            </button>
          ))}
          <FilterToggle on={assignee === "none"} onClick={() => toggleAssignee("none")}>
            Unassigned
          </FilterToggle>
          <FilterToggle on={assignee === "@me"} onClick={() => toggleAssignee("@me")}>
            Mine
          </FilterToggle>
          <div className="flex-1" />
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as IssueState)}
            aria-label="Issue state"
            className="rounded border border-neutral-800 bg-neutral-950 px-1 py-px text-neutral-400"
          >
            <option value="open">open</option>
            <option value="closed">closed</option>
            <option value="all">all</option>
          </select>
          <span className="text-neutral-600">{issues?.length ?? "…"}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto text-xs">
        {error && <div className="p-3 text-red-300">{error}</div>}
        {issues?.length === 0 && !error && (
          <div className="p-3 text-neutral-500">No matching issues</div>
        )}
        {issues?.map((issue) => {
          const wt = worktreeFor.get(issue.number);
          return (
            <div
              key={issue.number}
              role="button"
              tabIndex={0}
              onClick={() => openDetail(issue)}
              onKeyDown={(e) => {
                if (e.key === "Enter") openDetail(issue);
              }}
              title="Show details"
              className="flex cursor-default flex-col gap-1 border-b border-neutral-900 px-3 py-2 hover:bg-neutral-900 focus:bg-neutral-900 focus:outline-none"
            >
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 font-mono text-blue-400">#{issue.number}</span>
                <span className="min-w-0 flex-1 truncate text-neutral-200">{issue.title}</span>
                <span className="shrink-0 text-[10px] text-neutral-600">
                  {formatWhen(Date.parse(issue.updatedAt))}
                </span>
              </div>
              {(wt || issue.labels.length > 0 || issue.state === "closed" || issue.assignees.length > 0) && (
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                    {wt && <WorktreeBadge branch={wt.branch} />}
                    {issue.state === "closed" && (
                      <span className="rounded-full bg-violet-400/10 px-1.5 text-[10px] text-violet-300">
                        closed
                      </span>
                    )}
                    {issue.labels.map((l) => (
                      <LabelPill
                        key={l}
                        name={l}
                        title={`Filter by ${l}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          addLabel(l);
                        }}
                      />
                    ))}
                  </div>
                  <Assignees names={issue.assignees} size={16} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {detail && (
        <IssueDetail
          key={detail.number}
          workspaceId={workspaceId}
          issue={detail}
          onSaved={applyIssue}
          worktree={worktreeFor.get(detail.number) ?? null}
          onBack={() => setDetail(null)}
          onLabel={(l) => {
            addLabel(l);
            setDetail(null);
          }}
          onInsert={() => onInsert(detail)}
          onStart={() => onStart(detail)}
          onOpenWorktree={onOpenWorktree}
        />
      )}
      {creating && (
        <NewIssueForm
          workspaceId={workspaceId}
          onCancel={() => setCreating(false)}
          onCreated={(issue) => {
            setCreating(false);
            setReload((r) => r + 1);
            setDetail(issue);
          }}
        />
      )}
    </aside>
  );
}

/// One issue in full, covering the list (which stays mounted underneath).
/// Editing snapshots the issue it started from, so a newer copy arriving
/// meanwhile (an agent's edit) turns Save into a conflict instead of a
/// silent overwrite.
function IssueDetail({
  workspaceId,
  issue,
  worktree,
  onSaved,
  onBack,
  onLabel,
  onInsert,
  onStart,
  onOpenWorktree,
}: {
  workspaceId: WorkspaceId;
  issue: ForgeIssue;
  worktree: Worktree | null;
  onSaved: (issue: ForgeIssue) => void;
  onBack: () => void;
  onLabel: (label: string) => void;
  onInsert: () => void;
  onStart: () => void;
  onOpenWorktree: (wt: Worktree) => void;
}) {
  const [edit, setEdit] = useState<{ title: string; body: string; base: ForgeIssue } | null>(null);
  const [saving, setSaving] = useState(false);
  /// The forge's newer copy, when Save found the issue changed.
  const [conflict, setConflict] = useState<ForgeIssue | null>(null);

  const dirty = !!edit && (edit.title !== edit.base.title || edit.body !== edit.base.body);

  function cancelEdit() {
    setEdit(null);
    setConflict(null);
  }

  function startEdit() {
    setConflict(null);
    setEdit({ title: issue.title, body: issue.body, base: issue });
  }

  async function save(overwrite: boolean) {
    if (!edit || !edit.title.trim() || saving) return;
    if (!overwrite && !dirty) {
      setEdit(null);
      return;
    }
    setSaving(true);
    try {
      const saved = await forgeUpdateIssue(
        workspaceId,
        issue.number,
        edit.title.trim(),
        edit.body,
        overwrite ? null : edit.base.updatedAt,
      );
      setEdit(null);
      setConflict(null);
      onSaved(saved);
    } catch (e) {
      if (errorKind(e) === "Conflict") {
        try {
          setConflict(await forgeGetIssue(workspaceId, issue.number));
        } catch (e2) {
          toastError(`#${issue.number} changed and couldn't be re-read`, asMessage(e2));
        }
      } else {
        toastError(`Couldn't update #${issue.number}`, asMessage(e));
      }
    } finally {
      setSaving(false);
    }
  }

  function useTheirs() {
    if (!conflict) return;
    onSaved(conflict);
    setConflict(null);
    setEdit(null);
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-neutral-950">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-1.5 text-xs">
        {edit ? (
          <span className="px-1.5 py-0.5 text-neutral-300">Editing #{issue.number}</span>
        ) : (
          <button
            onClick={onBack}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <ArrowLeft size={13} />
            Issues
          </button>
        )}
        <div className="flex-1" />
        {!edit && (
          <button
            onClick={startEdit}
            title="Edit the title and description"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <Pencil size={11} /> Edit
          </button>
        )}
        <button
          onClick={() => void openExternalUrl(issue.url)}
          title={issue.url}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
        >
          Open <ExternalLink size={11} />
        </button>
      </div>
      {conflict && (
        <div className="border-b border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          <div>
            #{issue.number} changed on the forge since you started editing
            {conflict.updatedAt ? ` (${relativeTime(Date.parse(conflict.updatedAt))})` : ""}.
          </div>
          <div className="mt-1.5 flex gap-1.5">
            <RowButton onClick={useTheirs} title="Discard your edits and show the current version">
              Use theirs
            </RowButton>
            <RowButton onClick={() => void save(true)} title="Replace their version with yours">
              Overwrite with mine
            </RowButton>
          </div>
        </div>
      )}
      {edit ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <input
            autoFocus
            value={edit.title}
            onChange={(e) => setEdit({ ...edit, title: e.target.value })}
            aria-label="Issue title"
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-[13px] font-medium text-neutral-100 focus:border-neutral-500 focus:outline-none"
          />
          <textarea
            value={edit.body}
            onChange={(e) => setEdit({ ...edit, body: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) {
                e.preventDefault();
                void save(false);
              }
            }}
            aria-label="Issue description"
            placeholder="Description (markdown)"
            className="min-h-0 flex-1 resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-[12px] leading-relaxed text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-neutral-800/80 px-3.5 pb-3 pt-2.5">
            <div className="flex items-center gap-2 text-[10.5px]">
              <IssueStateBadge state={issue.state} />
              <span className="font-mono text-neutral-500">#{issue.number}</span>
              <span className="text-neutral-600" title={issue.updatedAt}>
                updated {relativeTime(Date.parse(issue.updatedAt))}
              </span>
            </div>
            <h2 className="mt-1.5 break-words text-[14px] font-medium leading-snug text-neutral-100">
              {issue.title}
            </h2>
            {(issue.labels.length > 0 || issue.assignees.length > 0) && (
              <div className="mt-2 flex items-center gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                  {issue.labels.map((l) => (
                    <LabelPill key={l} name={l} title={`Filter by ${l}`} onClick={() => onLabel(l)} />
                  ))}
                </div>
                <Assignees names={issue.assignees} size={20} />
              </div>
            )}
            {worktree && (
              <div className="mt-2">
                <WorktreeBadge branch={worktree.branch} />
              </div>
            )}
          </div>
          <div className="px-3.5 py-3 text-[12.5px]">
            {issue.body.trim() ? (
              <ForgeMarkdown source={issue.body} />
            ) : (
              <span className="text-[12px] italic text-neutral-600">No description.</span>
            )}
          </div>
        </div>
      )}
      <div className="flex items-center gap-1.5 border-t border-neutral-800 px-3 py-2">
        {edit ? (
          <>
            <RowButton onClick={cancelEdit}>Cancel</RowButton>
            <div className="flex-1" />
            <span className="text-[10px] text-neutral-600">⌘↵</span>
            <RowButton
              primary
              onClick={() => void save(false)}
              title={!edit.title.trim() ? "A title is required" : undefined}
            >
              {saving ? "Saving…" : "Save"}
            </RowButton>
          </>
        ) : (
          <>
            <RowButton onClick={onInsert} title="Add #n and the title to the planner's prompt">
              Insert #{issue.number}
            </RowButton>
            <div className="flex-1" />
            {worktree ? (
              <RowButton primary onClick={() => onOpenWorktree(worktree)}>
                Open worktree
              </RowButton>
            ) : (
              <RowButton primary onClick={onStart}>
                Start worktree
              </RowButton>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/// File a new issue from the drawer; on success the drawer shows it.
function NewIssueForm({
  workspaceId,
  onCancel,
  onCreated,
}: {
  workspaceId: WorkspaceId;
  onCancel: () => void;
  onCreated: (issue: ForgeIssue) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      onCreated(await forgeCreateIssue(workspaceId, title.trim(), body));
    } catch (e) {
      toastError("Couldn't file the issue", asMessage(e));
      setSaving(false);
    }
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-neutral-950">
      <div className="flex items-center border-b border-neutral-800 px-3.5 py-2 text-xs text-neutral-300">
        New issue
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          aria-label="New issue title"
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-[13px] font-medium text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) {
              e.preventDefault();
              void create();
            }
          }}
          placeholder="Description (markdown): the problem, where it shows up, what done looks like"
          aria-label="New issue description"
          className="min-h-0 flex-1 resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-[12px] leading-relaxed text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
      </div>
      <div className="flex items-center gap-1.5 border-t border-neutral-800 px-3 py-2">
        <RowButton onClick={onCancel}>Cancel</RowButton>
        <div className="flex-1" />
        <span className="text-[10px] text-neutral-600">⌘↵</span>
        <RowButton
          primary
          onClick={() => void create()}
          title={title.trim() ? "File it on the forge (visible to the team)" : "A title is required"}
        >
          {saving ? "Filing…" : "File issue"}
        </RowButton>
      </div>
    </div>
  );
}

function WorktreeBadge({ branch }: { branch: string }) {
  return (
    <span
      title={`Being worked on in ${branch}`}
      className="max-w-full truncate rounded-full border border-emerald-500/40 px-1.5 text-[10px] text-emerald-400"
    >
      ⑂ {branch}
    </span>
  );
}

function Assignees({ names, size }: { names: string[]; size: number }) {
  if (names.length === 0) return null;
  return (
    <div className="flex shrink-0 -space-x-1.5" title={`Assigned to ${names.join(", ")}`}>
      {names.slice(0, 4).map((a) => (
        <Avatar key={a} name={a} size={size} className="ring-2 ring-neutral-950" />
      ))}
    </div>
  );
}

function FilterToggle({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "rounded-full border px-2 py-px",
        on
          ? "border-blue-500/50 text-blue-300"
          : "border-neutral-700 text-neutral-400 hover:bg-neutral-800",
      )}
    >
      {children}
    </button>
  );
}

function RowButton({
  primary,
  onClick,
  title,
  children,
}: {
  primary?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className={cn(
        "rounded border px-2 py-0.5 text-[11px]",
        primary
          ? "border-blue-600 bg-blue-700 text-white hover:bg-blue-600"
          : "border-neutral-700 text-neutral-300 hover:bg-neutral-800",
      )}
    >
      {children}
    </button>
  );
}
