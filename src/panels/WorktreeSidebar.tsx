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
  const refresh = useWorktreesStore((s) => s.refresh);
  const createWt = useWorktreesStore((s) => s.create);
  const removeWt = useWorktreesStore((s) => s.remove);
  const selectedId = useUiStore((s) => s.selectedWorktreeId);
  const selectWorktree = useUiStore((s) => s.selectWorktree);
  const collapsed = useUiStore((s) => s.worktreeSidebarCollapsed);
  const toggleCollapsed = useUiStore((s) => s.toggleWorktreeSidebar);

  const [name, setName] = useState("");
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [mergeTarget, setMergeTarget] = useState<Worktree | null>(null);
  const [syncTarget, setSyncTarget] = useState<Worktree | null>(null);
  const syncStrategyDefault = useSettingsStore((s) => s.settings.syncStrategy);
  const mergeStrategyDefault = useSettingsStore(
    (s) => s.settings.mergeBackStrategy,
  );
  const initSubmodulesDefault = useSettingsStore(
    (s) => s.settings.initSubmodules,
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
    const trimmed = name.trim();
    setCreatingName(trimmed);
    try {
      const wt = await createWt(workspace.id, trimmed, {
        initSubmodules: initSubmodulesDefault,
      });
      if (wt) {
        setName("");
        inputRef.current?.focus();
        selectWorktree(wt.id);
      }
    } finally {
      setCreatingName(null);
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

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-1 overflow-y-auto border-r border-neutral-800 py-2">
        <button
          onClick={toggleCollapsed}
          title="Expand sidebar (⌘B)"
          className="rounded p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
        >
          ▶
        </button>
        {mainClone && (
          <RailButton
            tooltip={`${mainClone.branch} — main clone`}
            onClick={() => selectWorktree(mainClone.id)}
            selected={selectedId === mainClone.id}
            variant="main"
          >
            ◆
          </RailButton>
        )}
        {(() => {
          const { withAgent, changes, dormant } = groupWorktrees(
            regular,
            activity,
          );
          const renderDot = (w: Worktree) => {
            const a = activity[w.id];
            const tooltip =
              w.branch +
              (a?.ahead ? `  ↑${a.ahead}` : "") +
              (a?.behind ? `  ↓${a.behind}` : "");
            return (
              <RailButton
                key={w.id}
                tooltip={tooltip}
                onClick={() => selectWorktree(w.id)}
                selected={selectedId === w.id}
              >
                <StatusDot activity={a?.activity ?? "inactive"} />
              </RailButton>
            );
          };
          return (
            <>
              {withAgent.map(renderDot)}
              {withAgent.length > 0 && (changes.length > 0 || dormant.length > 0) && (
                <RailDivider />
              )}
              {changes.map(renderDot)}
              {changes.length > 0 && dormant.length > 0 && <RailDivider />}
              {dormant.map(renderDot)}
            </>
          );
        })()}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-r border-neutral-800">
      <div className="flex items-center justify-between border-b border-neutral-900 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          Worktrees
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-neutral-600">{regular.length}</span>
          <button
            onClick={toggleCollapsed}
            title="Collapse sidebar (⌘B)"
            className="rounded px-1 text-[11px] text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
          >
            ◀
          </button>
        </div>
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
          className="flex items-center justify-center rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {creating ? <Spinner /> : "+"}
        </button>
      </form>

      {creatingName && (
        <div className="flex items-center gap-2 border-b border-neutral-900 px-3 py-2 text-[11px] text-neutral-500">
          <Spinner />
          <span>
            Creating{" "}
            <span className="font-mono text-neutral-300">{creatingName}</span>
            … this can take a moment if the remote is slow to fetch.
          </span>
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
              <span className="mt-0.5 shrink-0 text-[11px] text-blue-400">◆</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs text-neutral-100">
                  {mainClone.branch}
                </div>
                <div className="truncate text-[11px] uppercase tracking-wider text-neutral-500">
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
          (() => {
            const { withAgent, changes, dormant } = groupWorktrees(
              regular,
              activity,
            );
            const renderRow = (w: Worktree, dim: boolean) => (
              <li
                key={w.id}
                className={cn(
                  "group relative flex cursor-pointer items-start px-3 py-2 hover:bg-neutral-900/50",
                  selectedId === w.id && "bg-neutral-900",
                  dim && "opacity-60",
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
                      <span className="truncate font-mono text-xs text-neutral-200">
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
                <RowMenu
                  behind={activity[w.id]?.behind ?? 0}
                  onSync={() => setSyncTarget(w)}
                  onMerge={() => setMergeTarget(w)}
                  onRemove={() => onRemove(w)}
                />
              </li>
            );
            return (
              <>
                {withAgent.length > 0 && (
                  <>
                    <SectionHeader label="Agents" count={withAgent.length} />
                    <ul className="divide-y divide-neutral-900">
                      {withAgent.map((w) => renderRow(w, false))}
                    </ul>
                  </>
                )}
                {changes.length > 0 && (
                  <>
                    <SectionHeader label="Changes" count={changes.length} />
                    <ul className="divide-y divide-neutral-900">
                      {changes.map((w) => renderRow(w, false))}
                    </ul>
                  </>
                )}
                {dormant.length > 0 && (
                  <>
                    <SectionHeader label="Inactive" count={dormant.length} />
                    <ul className="divide-y divide-neutral-900">
                      {dormant.map((w) => renderRow(w, true))}
                    </ul>
                  </>
                )}
              </>
            );
          })()
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
      {syncTarget && (
        <SyncDialog
          worktree={syncTarget}
          defaultBranch={workspace?.defaultBranch ?? "main"}
          behind={activity[syncTarget.id]?.behind ?? 0}
          initialStrategy={syncStrategyDefault}
          onClose={() => setSyncTarget(null)}
          onConfirm={async (strategy) => {
            const target = syncTarget;
            setSyncTarget(null);
            await onSync(target, strategy);
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

/// Rail button with a delayed floating tooltip anchored to the right of the
/// button. Tooltip uses `position: fixed` + the button's bounding rect so it
/// escapes the sidebar's `overflow-y-auto` clipping.
function RailButton({
  tooltip,
  onClick,
  selected,
  variant,
  children,
}: {
  tooltip: string;
  onClick: () => void;
  selected: boolean;
  variant?: "main";
  children: React.ReactNode;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );

  function onEnter() {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCoords({ top: rect.top + rect.height / 2, left: rect.right + 8 });
    }, 300);
  }
  function onLeave() {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setCoords(null);
  }
  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <>
      <button
        ref={btnRef}
        onClick={onClick}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded hover:bg-neutral-900",
          variant === "main" && "text-xs text-blue-400",
          selected &&
            (variant === "main"
              ? "bg-neutral-900"
              : "bg-neutral-900 ring-1 ring-neutral-700"),
        )}
      >
        {children}
      </button>
      {coords && (
        <div
          style={{
            position: "fixed",
            top: coords.top,
            left: coords.left,
            transform: "translateY(-50%)",
          }}
          className="pointer-events-none z-50 whitespace-nowrap rounded border border-neutral-800 bg-neutral-900 px-2 py-1 font-mono text-[11px] text-neutral-200 shadow-lg"
        >
          {tooltip}
        </div>
      )}
    </>
  );
}

function SyncDialog({
  worktree,
  defaultBranch,
  behind,
  initialStrategy,
  onConfirm,
  onClose,
}: {
  worktree: Worktree;
  defaultBranch: string;
  behind: number;
  initialStrategy: SyncStrategy;
  onConfirm: (strategy: SyncStrategy) => void;
  onClose: () => void;
}) {
  const [strategy, setStrategy] = useState<SyncStrategy>(initialStrategy);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[26rem] rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4">
          <div className="text-xs font-semibold text-neutral-100">
            Sync from {defaultBranch}
          </div>
          <div className="mt-1 font-mono text-[11px] text-neutral-500">
            {worktree.branch} · {behind} commit{behind === 1 ? "" : "s"} behind
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <StrategyOption
            value="rebase"
            current={strategy}
            onChange={setStrategy}
            label="Rebase"
            help="git rebase default — replays the agent's commits on top of the latest default. Auto-aborts on conflict."
          />
          <StrategyOption
            value="merge"
            current={strategy}
            onChange={setStrategy}
            label="Merge"
            help="git merge default — adds a merge commit. Conflicts are left in the workdir for you to resolve."
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              setSubmitting(true);
              onConfirm(strategy);
            }}
            disabled={submitting}
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {submitting ? "Syncing…" : strategy === "rebase" ? "Rebase" : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}

// StrategyOption is shared between MergeDialog and SyncDialog — generic over
// the strategy enum via `value`/`current`.
function StrategyOption<T extends string>({
  value,
  current,
  onChange,
  label,
  help,
}: {
  value: T;
  current: T;
  onChange: (v: T) => void;
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

function RowMenu({
  behind,
  onSync,
  onMerge,
  onRemove,
}: {
  behind: number;
  onSync: () => void;
  onMerge: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
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

  function run(fn: () => void) {
    return (e: React.MouseEvent) => {
      e.stopPropagation();
      setOpen(false);
      fn();
    };
  }

  return (
    <div ref={ref} className="absolute right-2 top-1.5">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn(
          "rounded px-1.5 py-0.5 text-xs leading-none text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200",
          open
            ? "bg-neutral-800 text-neutral-100 opacity-100"
            : "opacity-0 group-hover:opacity-100",
        )}
        title="Actions"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-[110%] z-30 w-40 overflow-hidden rounded border border-neutral-800 bg-neutral-900 py-1 shadow-xl">
          {behind > 0 && (
            <MenuItem onClick={run(onSync)}>
              Sync <span className="text-neutral-600">↓{behind}</span>
            </MenuItem>
          )}
          <MenuItem onClick={run(onMerge)}>Merge…</MenuItem>
          <div className="my-1 border-t border-neutral-800" />
          <MenuItem onClick={run(onRemove)} danger>
            Remove
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  children,
  danger,
}: {
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "block w-full px-3 py-1 text-left text-xs",
        danger
          ? "text-red-400 hover:bg-red-950/40"
          : "text-neutral-200 hover:bg-neutral-800",
      )}
    >
      {children}
    </button>
  );
}


function shortenPath(p: string): string {
  const parts = p.split("/");
  return parts.slice(-2).join("/");
}

/// Split worktrees into three buckets for sidebar grouping:
///  - withAgent: an agent session is attached (activity is working/idle/
///    needsAttention).
///  - changes: no agent session, but the branch is ahead of default or the
///    workdir is dirty. "Work without an agent watching it."
///  - dormant: no agent, no pending work. The truly stale pile.
/// Order within each group follows the sorted input (WorktreeId / creation
/// order — see `worktree::manager::list_for_workspace`).
function groupWorktrees(
  worktrees: Worktree[],
  activity: Record<WorktreeId, WorktreeActivity>,
): { withAgent: Worktree[]; changes: Worktree[]; dormant: Worktree[] } {
  const withAgent: Worktree[] = [];
  const changes: Worktree[] = [];
  const dormant: Worktree[] = [];
  for (const w of worktrees) {
    const a = activity[w.id];
    const act: AgentActivity = a?.activity ?? "inactive";
    if (act !== "inactive") {
      withAgent.push(w);
    } else if (
      !a?.merged &&
      ((a?.ahead ?? 0) > 0 || (a?.dirty ?? false))
    ) {
      // `merged: true` means the branch's work is already on default (e.g.
      // via squash-merge) — demote it to dormant regardless of `ahead`.
      changes.push(w);
    } else {
      dormant.push(w);
    }
  }
  return { withAgent, changes, dormant };
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="border-t border-neutral-800 px-3 py-1.5 text-[11px] uppercase tracking-wider text-neutral-600">
      {label} ({count})
    </div>
  );
}

function RailDivider() {
  return <div className="my-1 h-px w-4 bg-neutral-800" />;
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

function AheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
  if (ahead === 0 && behind === 0) return null;
  const fmt = (n: number) => (n > 99 ? "99+" : String(n));
  return (
    <span
      className="shrink-0 font-mono text-[11px] text-neutral-500"
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
      return { color: "bg-neutral-400", pulse: false, title: "agent: idle" };
    case "needsAttention":
      return {
        color: "bg-red-500",
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
