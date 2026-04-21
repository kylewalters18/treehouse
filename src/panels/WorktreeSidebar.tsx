import { useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import { useUiStore } from "@/stores/ui";
import {
  listAgentActivity,
  mergeWorktree,
  onWorktreesChanged,
} from "@/ipc/client";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import type {
  AgentActivity,
  Worktree,
  WorktreeActivity,
  WorktreeId,
} from "@/ipc/types";
import { cn } from "@/lib/cn";

export function WorktreeSidebar() {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const creating = useWorktreesStore((s) => s.creating);
  const error = useWorktreesStore((s) => s.error);
  const refresh = useWorktreesStore((s) => s.refresh);
  const createWt = useWorktreesStore((s) => s.create);
  const removeWt = useWorktreesStore((s) => s.remove);
  const selectedId = useUiStore((s) => s.selectedWorktreeId);
  const selectWorktree = useUiStore((s) => s.selectWorktree);

  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [mergeTarget, setMergeTarget] = useState<Worktree | null>(null);
  const [activity, setActivity] = useState<
    Record<WorktreeId, WorktreeActivity>
  >({});

  const mainClone = worktrees.find((w) => w.isMainClone) ?? null;
  const regular = worktrees.filter((w) => !w.isMainClone);

  useEffect(() => {
    if (!workspace) return;
    refresh(workspace.id);
    const unlistenPromise = onWorktreesChanged(workspace.id, () =>
      refresh(workspace.id),
    );
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [workspace, refresh]);

  // Poll agent activity so the dot next to each worktree stays fresh.
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    async function tick() {
      if (!workspace) return;
      try {
        const list = await listAgentActivity(workspace.id);
        if (cancelled) return;
        const map: Record<WorktreeId, WorktreeActivity> = {};
        for (const w of list) map[w.worktreeId] = w;
        setActivity(map);
      } catch {
        // Transient; we'll retry on the next tick.
      }
    }
    void tick();
    const handle = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [workspace]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace || !name.trim() || creating) return;
    const wt = await createWt(workspace.id, name.trim());
    if (wt) {
      setName("");
      inputRef.current?.focus();
      selectWorktree(wt.id);
    }
  }

  async function onRemove(w: Worktree) {
    const ok = window.confirm(
      `Remove worktree "${w.branch}"?\n\n${w.path}\n\nThis will delete the checkout and local branch.`,
    );
    if (!ok) return;
    await removeWt(w.id, true);
  }

  async function runMerge(
    w: Worktree,
    opts: { squash: boolean; commitMessage?: string },
  ) {
    try {
      const result = await mergeWorktree(w.id, opts);
      if (result.kind === "clean") {
        toastSuccess(
          `Merged ${w.branch}`,
          opts.squash ? "Squash-merge committed." : "Merge-back completed cleanly.",
        );
      } else if (result.kind === "nothingToMerge") {
        toastInfo(
          `Nothing to merge on ${w.branch}`,
          result.uncommittedChanges
            ? "The agent's workdir has uncommitted changes. Commit them in the worktree (e.g. via the agent or the terminal), then merge again."
            : "The branch has no commits beyond the default branch.",
        );
      } else if (result.kind === "conflict") {
        toastError(
          `Conflicts merging ${w.branch}`,
          `${result.message}\n\nResolve in the main repo and commit.`,
        );
      } else if (result.kind === "wrongBranch") {
        toastInfo(
          "Wrong branch",
          `Main repo is on '${result.current}'. Check out '${result.expected}' there first.`,
        );
      }
    } catch (e: unknown) {
      const msg = e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e);
      toastError("Merge failed", msg);
    }
  }

  return (
    <div className="flex h-full flex-col border-r border-neutral-800">
      <div className="flex items-center justify-between border-b border-neutral-900 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          Worktrees
        </span>
        <span className="text-[11px] text-neutral-600">{regular.length}</span>
      </div>

      <form
        onSubmit={onCreate}
        className="flex gap-2 border-b border-neutral-900 p-3"
      >
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new worktree name"
          className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none"
          disabled={!workspace || creating}
        />
        <button
          type="submit"
          disabled={!workspace || !name.trim() || creating}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {creating ? "…" : "+"}
        </button>
      </form>

      {error && (
        <div className="m-3 rounded border border-red-900/60 bg-red-950/40 px-2 py-1 text-[11px] text-red-300">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {mainClone && (
          <button
            onClick={() => selectWorktree(mainClone.id)}
            className={cn(
              "flex w-full items-center justify-between gap-2 border-b border-neutral-900 px-3 py-2 text-left hover:bg-neutral-900/50",
              selectedId === mainClone.id && "bg-neutral-900",
            )}
            title={`${mainClone.path} — main clone (merges land here; agents don't run here)`}
          >
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <span className="mt-0.5 shrink-0 text-[10px] text-blue-400">◆</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs text-neutral-100">
                  {mainClone.branch}
                </div>
                <div className="truncate text-[10px] uppercase tracking-wider text-neutral-500">
                  main clone
                </div>
              </div>
            </div>
          </button>
        )}
        {regular.length === 0 ? (
          <div className="m-3 rounded border border-dashed border-neutral-800 p-3 text-center text-[11px] text-neutral-600">
            No worktrees yet. Create one above.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-900">
            {regular.map((w) => (
              <li
                key={w.id}
                className={cn(
                  "group flex cursor-pointer items-start justify-between gap-2 px-3 py-2 hover:bg-neutral-900/50",
                  selectedId === w.id && "bg-neutral-900",
                )}
                onClick={() => selectWorktree(w.id)}
              >
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <StatusDot
                    activity={activity[w.id]?.activity ?? "inactive"}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate font-mono text-xs text-neutral-200">
                        {w.branch}
                      </span>
                      <AheadBehind
                        ahead={activity[w.id]?.ahead ?? 0}
                        behind={activity[w.id]?.behind ?? 0}
                      />
                    </div>
                    <div
                      className="truncate font-mono text-[10px] text-neutral-500"
                      title={w.path}
                    >
                      {shortenPath(w.path)}
                    </div>
                  </div>
                </div>
                <span className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setMergeTarget(w);
                    }}
                    className="rounded border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-emerald-800 hover:text-emerald-300"
                    title="Merge into default branch"
                  >
                    Merge
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(w);
                    }}
                    className="text-[11px] text-neutral-500 hover:text-red-400"
                    title="Remove worktree"
                  >
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {mergeTarget && (
        <MergeDialog
          worktree={mergeTarget}
          defaultBranch={workspace?.defaultBranch ?? "main"}
          onClose={() => setMergeTarget(null)}
          onConfirm={async (opts) => {
            const target = mergeTarget;
            setMergeTarget(null);
            await runMerge(target, opts);
          }}
        />
      )}
    </div>
  );
}

function MergeDialog({
  worktree,
  defaultBranch,
  onConfirm,
  onClose,
}: {
  worktree: Worktree;
  defaultBranch: string;
  onConfirm: (opts: { squash: boolean; commitMessage?: string }) => void;
  onClose: () => void;
}) {
  const [squash, setSquash] = useState(false);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canConfirm = !submitting && (!squash || message.trim().length > 0);

  async function submit() {
    if (!canConfirm) return;
    setSubmitting(true);
    onConfirm(
      squash ? { squash: true, commitMessage: message.trim() } : { squash: false },
    );
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[28rem] rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4">
          <div className="text-sm font-semibold text-neutral-100">
            Merge into {defaultBranch}
          </div>
          <div className="mt-1 font-mono text-[11px] text-neutral-500">
            {worktree.branch}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-neutral-200">
          <input
            type="checkbox"
            checked={squash}
            onChange={(e) => setSquash(e.target.checked)}
            className="h-3.5 w-3.5 accent-blue-600"
          />
          Squash into a single commit
        </label>
        <div className="mt-1 pl-[22px] text-[11px] text-neutral-500">
          {squash
            ? "Combines all commits on this branch into one on the default branch."
            : "Keeps per-commit history with a --no-ff merge commit."}
        </div>
        {squash && (
          <div className="mt-3">
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-500">
              Commit message
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="one line summary, blank line, optional body"
              rows={4}
              className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none"
              autoFocus
            />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canConfirm}
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {submitting ? "Merging…" : squash ? "Squash merge" : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  return parts.slice(-2).join("/");
}

function AheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
  if (ahead === 0 && behind === 0) return null;
  const fmt = (n: number) => (n > 99 ? "99+" : String(n));
  return (
    <span
      className="shrink-0 font-mono text-[10px] text-neutral-500"
      title={`${ahead} ahead of / ${behind} behind default branch`}
    >
      {ahead > 0 && (
        <span className="text-emerald-400">↑{fmt(ahead)}</span>
      )}
      {ahead > 0 && behind > 0 && <span className="mx-0.5 text-neutral-700">·</span>}
      {behind > 0 && (
        <span className="text-amber-400">↓{fmt(behind)}</span>
      )}
    </span>
  );
}

function StatusDot({
  activity,
  className,
}: {
  activity: AgentActivity;
  className?: string;
}) {
  const { color, pulse, title } = activityStyle(activity);
  return (
    <span
      title={title}
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        color,
        pulse && "animate-pulse",
        className,
      )}
    />
  );
}

function activityStyle(activity: AgentActivity): {
  color: string;
  pulse: boolean;
  title: string;
} {
  switch (activity) {
    case "working":
      return { color: "bg-emerald-500", pulse: true, title: "agent: working" };
    case "idle":
      return { color: "bg-amber-500", pulse: false, title: "agent: idle" };
    case "needsAttention":
      return {
        color: "bg-orange-500",
        pulse: true,
        title: "agent: needs attention",
      };
    case "inactive":
    default:
      return {
        color: "bg-neutral-700",
        pulse: false,
        title: "no agent",
      };
  }
}
