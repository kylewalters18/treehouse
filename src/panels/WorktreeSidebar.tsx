import { useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import { useUiStore } from "@/stores/ui";
import { useSettingsStore } from "@/stores/settings";
import {
  listAgentActivity,
  mergeWorktree,
  onWorktreesChanged,
  syncWorktree,
} from "@/ipc/client";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import type {
  AgentActivity,
  MergeBackStrategy,
  SyncStrategy,
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
  const syncStrategyDefault = useSettingsStore((s) => s.settings.syncStrategy);
  const mergeStrategyDefault = useSettingsStore(
    (s) => s.settings.mergeBackStrategy,
  );
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
    const a = activity[w.id];
    const warnings: string[] = [];
    if (a?.dirty) warnings.push("• uncommitted changes in the workdir");
    if ((a?.ahead ?? 0) > 0)
      warnings.push(`• ${a?.ahead} unmerged commit(s) on ${w.branch}`);
    const lead = `Remove worktree "${w.branch}"?\n\n${w.path}`;
    const tail = warnings.length
      ? `\n\nWarning — this will be lost:\n${warnings.join("\n")}\n\nDelete anyway?`
      : "\n\nThis will delete the checkout and local branch.";
    const ok = window.confirm(lead + tail);
    if (!ok) return;
    await removeWt(w.id, true);
  }

  async function onSync(w: Worktree, strategy: SyncStrategy) {
    try {
      const result = await syncWorktree(w.id, strategy);
      if (result.kind === "clean") {
        toastSuccess(
          `Synced ${w.branch}`,
          strategy === "rebase"
            ? `Rebased onto default branch.`
            : `Default branch merged into ${w.branch}.`,
        );
      } else if (result.kind === "alreadyUpToDate") {
        toastInfo(`${w.branch} is up to date`, "Nothing to sync.");
      } else if (result.kind === "dirty") {
        toastInfo(
          `${w.branch} has uncommitted changes`,
          "Commit them before syncing — git won't merge or rebase over a dirty workdir.",
        );
      } else if (result.kind === "conflict") {
        toastError(
          `Conflicts syncing ${w.branch}`,
          `${result.message}\n\nResolve in the worktree's terminal and commit.`,
        );
      } else if (result.kind === "rebaseAborted") {
        toastError(
          `Rebase aborted on ${w.branch}`,
          `${result.message}\n\nThe worktree was left clean. Try the Merge sync strategy instead.`,
        );
      }
    } catch (e: unknown) {
      const msg =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      toastError("Sync failed", msg);
    }
  }

  async function runMerge(
    w: Worktree,
    opts: { strategy: MergeBackStrategy; commitMessage?: string },
  ) {
    try {
      const result = await mergeWorktree(w.id, opts.strategy, opts.commitMessage);
      const label = strategyLabel(opts.strategy);
      if (result.kind === "clean") {
        toastSuccess(`Merged ${w.branch}`, `${label} completed cleanly.`);
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
      } else if (result.kind === "rebaseAborted") {
        toastError(
          `Rebase pre-step aborted on ${w.branch}`,
          `${result.message}\n\nThe worktree was left as-is. Try a Merge-commit strategy, or sync first.`,
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
                  "group relative flex cursor-pointer items-start px-3 py-2 hover:bg-neutral-900/50",
                  selectedId === w.id && "bg-neutral-900",
                )}
                onClick={() => selectWorktree(w.id)}
              >
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <StatusDot
                    activity={activity[w.id]?.activity ?? "inactive"}
                    className="mt-1.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate font-mono text-sm text-neutral-100">
                        {w.branch}
                      </span>
                      <AheadBehind
                        ahead={activity[w.id]?.ahead ?? 0}
                        behind={activity[w.id]?.behind ?? 0}
                      />
                    </div>
                    <div
                      className="truncate font-mono text-[11px] text-neutral-500"
                      title={w.path}
                    >
                      {shortenPath(w.path)}
                    </div>
                  </div>
                </div>
                <span className="pointer-events-none absolute right-2 top-1.5 flex items-center gap-1 rounded bg-neutral-900/95 px-1 opacity-0 shadow-sm transition group-hover:pointer-events-auto group-hover:opacity-100">
                  {(activity[w.id]?.behind ?? 0) > 0 && (
                    <SyncButton
                      behind={activity[w.id]?.behind ?? 0}
                      defaultStrategy={syncStrategyDefault}
                      onSync={(strategy) => onSync(w, strategy)}
                    />
                  )}
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
          initialStrategy={mergeStrategyDefault}
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
  initialStrategy,
  onConfirm,
  onClose,
}: {
  worktree: Worktree;
  defaultBranch: string;
  initialStrategy: MergeBackStrategy;
  onConfirm: (opts: {
    strategy: MergeBackStrategy;
    commitMessage?: string;
  }) => void;
  onClose: () => void;
}) {
  const [strategy, setStrategy] = useState<MergeBackStrategy>(initialStrategy);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const needsMessage = strategy === "squash";
  const canConfirm =
    !submitting && (!needsMessage || message.trim().length > 0);

  async function submit() {
    if (!canConfirm) return;
    setSubmitting(true);
    onConfirm({
      strategy,
      commitMessage: needsMessage ? message.trim() : undefined,
    });
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
        <div className="flex flex-col gap-2">
          <StrategyOption
            value="mergeNoFf"
            current={strategy}
            onChange={setStrategy}
            label="Merge commit"
            help="git merge --no-ff — keeps per-commit history with an explicit merge commit."
          />
          <StrategyOption
            value="squash"
            current={strategy}
            onChange={setStrategy}
            label="Squash + commit"
            help="git merge --squash + commit — collapses every commit on this branch into one on default."
          />
          <StrategyOption
            value="rebaseFf"
            current={strategy}
            onChange={setStrategy}
            label="Rebase + fast-forward"
            help="git rebase default in the worktree, then git merge --ff-only — linear history, no merge commit. Auto-aborts the rebase if it conflicts."
          />
        </div>
        {needsMessage && (
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
            {submitting ? "Merging…" : strategyLabel(strategy)}
          </button>
        </div>
      </div>
    </div>
  );
}

function StrategyOption({
  value,
  current,
  onChange,
  label,
  help,
}: {
  value: MergeBackStrategy;
  current: MergeBackStrategy;
  onChange: (v: MergeBackStrategy) => void;
  label: string;
  help: string;
}) {
  const active = value === current;
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 text-xs",
        active
          ? "border-blue-700 bg-blue-950/30"
          : "border-neutral-800 hover:bg-neutral-950",
      )}
    >
      <input
        type="radio"
        checked={active}
        onChange={() => onChange(value)}
        className="mt-0.5 accent-blue-600"
      />
      <span className="flex-1">
        <div className="font-medium text-neutral-100">{label}</div>
        <div className="mt-0.5 text-[11px] text-neutral-500">{help}</div>
      </span>
    </label>
  );
}

function strategyLabel(s: MergeBackStrategy): string {
  switch (s) {
    case "mergeNoFf":
      return "Merge";
    case "squash":
      return "Squash merge";
    case "rebaseFf":
      return "Rebase merge";
  }
}

function SyncButton({
  behind,
  defaultStrategy,
  onSync,
}: {
  behind: number;
  defaultStrategy: SyncStrategy;
  onSync: (strategy: SyncStrategy) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    function onDocClick() {
      setOpen(false);
    }
    window.addEventListener("click", onDocClick);
    return () => window.removeEventListener("click", onDocClick);
  }, [open]);

  const defaultLabel = defaultStrategy === "rebase" ? "rebase" : "merge";

  return (
    <span className="relative inline-flex">
      <button
        onClick={(e) => {
          e.stopPropagation();
          onSync(defaultStrategy);
        }}
        className="rounded-l border border-r-0 border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-blue-800 hover:text-blue-300"
        title={`Pull ${behind} commit(s) from default branch (${defaultLabel}; configurable in ⚙)`}
      >
        Sync ↓
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="rounded-r border border-neutral-800 px-1 py-0.5 text-[10px] text-neutral-400 hover:border-blue-800 hover:text-blue-300"
        title="One-off sync strategy override"
      >
        ▾
      </button>
      {open && (
        <div className="absolute right-0 top-[110%] z-30 w-44 rounded border border-neutral-800 bg-neutral-900 py-1 shadow-xl">
          <SyncMenuItem
            label="Rebase"
            sub="git rebase default; aborts on conflict"
            onClick={() => {
              setOpen(false);
              onSync("rebase");
            }}
          />
          <SyncMenuItem
            label="Merge"
            sub="git merge default"
            onClick={() => {
              setOpen(false);
              onSync("merge");
            }}
          />
        </div>
      )}
    </span>
  );
}

function SyncMenuItem({
  label,
  sub,
  onClick,
}: {
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="block w-full px-2 py-1 text-left text-[11px] hover:bg-neutral-800"
    >
      <div className="text-neutral-100">{label}</div>
      <div className="font-mono text-[10px] text-neutral-500">{sub}</div>
    </button>
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
