import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import { useUiStore } from "@/stores/ui";
import { useSettingsStore } from "@/stores/settings";
import {
  listAgentActivity,
  mergeWorktree,
  onWorktreeCreateStep,
  onWorktreesChanged,
  syncWorktree,
} from "@/ipc/client";
import { NewWorktreeDialog } from "@/components/NewWorktreeDialog";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import type {
  AgentActivity,
  MergeBackStrategy,
  SyncStrategy,
  Workspace,
  Worktree,
  WorktreeActivity,
  WorktreeId,
} from "@/ipc/types";
import { cn } from "@/lib/cn";
import { runWorktreeSetup } from "@/lib/worktree-setup";
import {
  inboxWorktrees,
  nextAcks,
  splitActive,
  statusCounts,
  type Acks,
  type StatusCounts,
} from "./worktree-sidebar-model";

export function WorktreeSidebar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const closeWorkspaceStore = useWorkspaceStore((s) => s.closeWorkspace);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const creating = useWorktreesStore((s) => s.creating);
  const refresh = useWorktreesStore((s) => s.refresh);
  const dropForWorkspace = useWorktreesStore((s) => s.dropForWorkspace);
  const createWt = useWorktreesStore((s) => s.create);
  const removeWt = useWorktreesStore((s) => s.remove);
  const selectedId = useUiStore((s) => s.selectedWorktreeId);
  const selectWorktree = useUiStore((s) => s.selectWorktree);
  const collapsed = useUiStore((s) => s.worktreeSidebarCollapsed);
  const toggleCollapsed = useUiStore((s) => s.toggleWorktreeSidebar);

  // Which repo's New Worktree dialog is open (null = closed). Lives in
  // the ui store so the Cmd+Shift+N global shortcut can open it too.
  const createDialogWs = useUiStore((s) => s.newWorktreeWorkspace);
  const openCreateDialog = useUiStore((s) => s.openNewWorktreeDialog);
  const closeCreateDialog = useUiStore((s) => s.closeNewWorktreeDialog);
  // Per-repo in-flight create indicator + live step, for the spinner shown
  // under the repo while a create runs.
  const [creatingNames, setCreatingNames] = useState<
    Record<string, string | null>
  >({});
  const [creatingSteps, setCreatingSteps] = useState<
    Record<string, string | null>
  >({});
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
  // Per-repo collapse state. Expanded by default; the header's status
  // tally keeps a collapsed repo legible. The repo owning the
  // *selected* worktree auto-expands so a click from the "Needs you"
  // inbox lands on a visible row.
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());
  // Repos whose "N inactive" pile is expanded. Collapsed by default.
  const [openInactive, setOpenInactive] = useState<Set<string>>(new Set());
  // Idle agents the user has already looked at — see `nextAcks`.
  const [acks, setAcks] = useState<Acks>({});

  // Stable key so the per-workspace effect re-runs precisely when the
  // *set* of open workspaces changes (not on every store update).
  const workspaceIdsKey = workspaces.map((w) => w.id).join("|");

  useEffect(() => {
    if (workspaces.length === 0) return;
    // Refresh every open workspace's worktrees on mount + on changes.
    // Multi-repo: refresh is merge-not-replace so concurrent refreshes
    // don't clobber each other.
    workspaces.forEach((ws) => {
      refresh(ws.id);
    });
    const unlisteners: Array<Promise<() => void>> = [];
    for (const ws of workspaces) {
      unlisteners.push(
        onWorktreesChanged(ws.id, () => {
          refresh(ws.id);
        }),
      );
      unlisteners.push(
        onWorktreeCreateStep(ws.id, (step) => {
          setCreatingSteps((prev) => ({ ...prev, [ws.id]: step }));
        }),
      );
    }
    return () => {
      for (const p of unlisteners) {
        p.then((fn) => fn()).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceIdsKey, refresh]);

  // Poll agent activity for every open workspace so the dot next to
  // each worktree (across all repos) stays fresh.
  useEffect(() => {
    if (workspaces.length === 0) return;
    let cancelled = false;
    async function tick() {
      const lists = await Promise.allSettled(
        useWorkspaceStore
          .getState()
          .workspaces.map((ws) => listAgentActivity(ws.id)),
      );
      if (cancelled) return;
      const map: Record<WorktreeId, WorktreeActivity> = {};
      for (const r of lists) {
        if (r.status !== "fulfilled") continue;
        for (const w of r.value) map[w.worktreeId] = w;
      }
      setActivity(map);
    }
    void tick();
    const handle = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceIdsKey]);

  const showRepoChips = workspaces.length > 1;

  useEffect(() => {
    setAcks((prev) => nextAcks(prev, activity, selectedId));
  }, [activity, selectedId]);

  // Reveal the selected worktree: expand its repo, and its inactive
  // pile if that's where it lives.
  useEffect(() => {
    if (!selectedId) return;
    const wt = worktrees.find((w) => w.id === selectedId);
    if (!wt) return;
    setCollapsedRepos((prev) => {
      if (!prev.has(wt.workspaceId)) return prev;
      const next = new Set(prev);
      next.delete(wt.workspaceId);
      return next;
    });
    if (wt.isMainClone) return;
    const { inactive } = splitActive([wt], activity);
    if (inactive.length === 0) return;
    setOpenInactive((prev) => {
      if (prev.has(wt.workspaceId)) return prev;
      const next = new Set(prev);
      next.add(wt.workspaceId);
      return next;
    });
    // `activity` deliberately omitted: re-running on every 1.5s poll
    // would re-open a pile the user just collapsed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, worktrees]);

  function toggleIn(
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string,
  ) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Run the actual create (with progress + setup) — fed by the New Worktree
  // dialog, which collects name / base / options.
  async function handleCreate(
    workspaceId: string,
    name: string,
    base: string | null,
    opts: { initSubmodules: boolean; runSetup: boolean },
  ) {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreatingNames((prev) => ({ ...prev, [workspaceId]: trimmed }));
    setCreatingSteps((prev) => ({ ...prev, [workspaceId]: null }));
    try {
      const wt = await createWt(workspaceId, trimmed, {
        initSubmodules: opts.initSubmodules,
        base,
      });
      if (wt) {
        selectWorktree(wt.id);
        if (opts.runSetup) {
          void runWorktreeSetup(wt.id);
        }
      }
    } finally {
      setCreatingNames((prev) => ({ ...prev, [workspaceId]: null }));
      setCreatingSteps((prev) => ({ ...prev, [workspaceId]: null }));
    }
  }

  async function pickAndOpenAnotherRepo() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Select a git repository to open",
    });
    if (typeof picked === "string") {
      await openWorkspace(picked);
    }
  }

  async function onCloseRepo(ws: Workspace) {
    // Confirm if there's a live agent or any dirty worktree in this
    // repo — closing tears down PTYs and worktree state.
    const repoWorktrees = worktrees.filter((w) => w.workspaceId === ws.id);
    const liveAgents = repoWorktrees.filter(
      (w) => activity[w.id] !== undefined && activity[w.id].activity !== "inactive",
    );
    const dirty = repoWorktrees.filter((w) => activity[w.id]?.dirty);
    if (liveAgents.length > 0 || dirty.length > 0) {
      const reasons: string[] = [];
      if (liveAgents.length > 0)
        reasons.push(
          `• ${liveAgents.length} live agent(s) will be killed`,
        );
      if (dirty.length > 0)
        reasons.push(
          `• ${dirty.length} worktree(s) have uncommitted changes`,
        );
      const repoLabel = basenameOf(ws.root);
      const ok = window.confirm(
        `Close "${repoLabel}"?\n\n${ws.root}\n\n${reasons.join("\n")}\n\nThe on-disk worktrees are kept; this just detaches them from treehouse.`,
      );
      if (!ok) return;
    }
    // Drop UI-side worktree entries immediately so the sidebar doesn't
    // briefly render the section after close while Rust tears down.
    dropForWorkspace(ws.id);
    // If the selected worktree belonged to this repo, fall back to
    // any remaining worktree (cross-repo) or null.
    const sel = useUiStore.getState().selectedWorktreeId;
    if (sel && repoWorktrees.some((w) => w.id === sel)) {
      const fallback = worktrees.find(
        (w) => w.workspaceId !== ws.id,
      );
      selectWorktree(fallback?.id ?? null);
    }
    await closeWorkspaceStore(ws.id);
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

  const allRegular = worktrees.filter((w) => !w.isMainClone);
  const inbox = inboxWorktrees(allRegular, activity, acks);
  const repoName = (w: Worktree) =>
    basenameOf(workspaces.find((ws) => ws.id === w.workspaceId)?.root ?? "");

  if (collapsed) {
    // Collapsed rail mirrors the expanded layout: inbox dots on top,
    // then each repo's ◆ main + worktree dots in stable order.
    const renderDot = (w: Worktree) => {
      const a = activity[w.id];
      const tooltip =
        (showRepoChips ? `${repoName(w)} · ` : "") +
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
      <div className="flex h-full flex-col items-center gap-1 overflow-y-auto border-r border-neutral-800 py-2">
        <button
          onClick={toggleCollapsed}
          title="Expand sidebar (⌘B)"
          className="rounded p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
        >
          ▶
        </button>
        {inbox.length > 0 && (
          <>
            {inbox.map(renderDot)}
            <RailDivider />
          </>
        )}
        {workspaces.map((ws, wsIdx) => {
          const repoWorktrees = worktrees.filter(
            (w) => w.workspaceId === ws.id,
          );
          const mainClone =
            repoWorktrees.find((w) => w.isMainClone) ?? null;
          const { active, inactive } = splitActive(
            repoWorktrees.filter((w) => !w.isMainClone),
            activity,
          );
          return (
            <div key={ws.id} className="flex flex-col items-center gap-1">
              {wsIdx > 0 && <RailDivider />}
              {mainClone && (
                <RailButton
                  tooltip={`${basenameOf(ws.root)} · ${mainClone.branch}`}
                  onClick={() => selectWorktree(mainClone.id)}
                  selected={selectedId === mainClone.id}
                  variant="main"
                >
                  ◆
                </RailButton>
              )}
              {active.map(renderDot)}
              {inactive.map(renderDot)}
            </div>
          );
        })}
      </div>
    );
  }

  const renderRow = (w: Worktree, opts: { dim?: boolean; chip?: boolean }) => {
    const a = activity[w.id];
    return (
      <li
        key={w.id}
        className={cn(
          "group relative flex cursor-pointer items-center py-1 pl-3 pr-1 hover:bg-neutral-900/50",
          selectedId === w.id && "bg-neutral-900",
        )}
        onClick={() => selectWorktree(w.id)}
        title={w.path}
      >
        {/* Dim the row CONTENT but not the row itself — `opacity` <1
            creates a stacking context, and applying it to the <li>
            traps RowMenu's dropdown inside that context: sibling
            rows below paint over the popup and swallow its clicks. */}
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2",
            opts.dim && "opacity-60",
          )}
        >
          <StatusDot activity={a?.activity ?? "inactive"} />
          {opts.chip && (
            <span className="shrink-0 font-mono text-[11px] text-neutral-500">
              {repoName(w)} /
            </span>
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-200">
            {w.branch}
          </span>
          {/* Badges give way to the ⋯ menu on hover (and while it's
              open) so the one-line row never has to fit both. */}
          <span className="flex shrink-0 items-center gap-2 group-hover:hidden group-has-[[data-open]]:hidden">
            {(a?.agentCount ?? 0) > 1 && (
              <span
                className="font-mono text-[10px] text-neutral-500"
                title={`${a?.agentCount} agents`}
              >
                ×{a?.agentCount}
              </span>
            )}
            <AheadBehind ahead={a?.ahead ?? 0} behind={a?.behind ?? 0} />
          </span>
        </div>
        <RowMenu
          behind={a?.behind ?? 0}
          onSync={() => setSyncTarget(w)}
          onMerge={() => setMergeTarget(w)}
          onRemove={() => onRemove(w)}
        />
      </li>
    );
  };

  // Default branch for the merge/sync dialogs — derived from the
  // worktree's own workspace so a worktree in repo B doesn't end up
  // diffing against repo A's main.
  function defaultBranchFor(w: Worktree | null): string {
    if (!w) return "main";
    const ws = workspaces.find((x) => x.id === w.workspaceId);
    return ws?.defaultBranch ?? "main";
  }

  return (
    <div className="flex h-full flex-col border-r border-neutral-800">
      <div className="flex items-center justify-between border-b border-neutral-900 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          {showRepoChips ? "Repos" : "Worktrees"}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-neutral-600">{allRegular.length}</span>
          <button
            onClick={toggleCollapsed}
            title="Collapse sidebar (⌘B)"
            className="rounded px-1 text-[11px] text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
          >
            ◀
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {inbox.length > 0 && (
          <div className="border-b border-neutral-800 bg-amber-400/[0.03]">
            <SectionHeader label="Needs you" count={inbox.length} />
            <ul>{inbox.map((w) => renderRow(w, { chip: showRepoChips }))}</ul>
          </div>
        )}

        {workspaces.map((ws) => {
          const repoWorktrees = worktrees.filter(
            (w) => w.workspaceId === ws.id,
          );
          const mainClone =
            repoWorktrees.find((w) => w.isMainClone) ?? null;
          const regular = repoWorktrees.filter((w) => !w.isMainClone);
          const { active, inactive } = splitActive(regular, activity);
          const liveName = creatingNames[ws.id];
          const liveStep = creatingSteps[ws.id];
          const expanded = !collapsedRepos.has(ws.id);
          const inactiveOpen = openInactive.has(ws.id);
          return (
            <div key={ws.id} className="border-b border-neutral-900">
              <div
                role="button"
                onClick={() => toggleIn(setCollapsedRepos, ws.id)}
                className="group/repo flex w-full cursor-pointer items-center justify-between gap-2 bg-neutral-950 px-2 py-1.5 hover:bg-neutral-900/60"
                title={ws.root}
              >
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  {expanded ? (
                    <ChevronDown size={12} className="shrink-0 text-neutral-500" />
                  ) : (
                    <ChevronRight size={12} className="shrink-0 text-neutral-500" />
                  )}
                  <span className="truncate font-mono text-[11px] text-neutral-300">
                    {basenameOf(ws.root)}
                  </span>
                  <RepoStatus counts={statusCounts(regular, activity)} />
                </span>
                <span className="flex shrink-0 items-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openCreateDialog(ws.id);
                    }}
                    disabled={creating || !!liveName}
                    title="New worktree (⌘⇧N)"
                    className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
                  >
                    {liveName ? <Spinner /> : <Plus size={13} />}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void onCloseRepo(ws);
                    }}
                    title={`Close ${basenameOf(ws.root)} (other repos stay open)`}
                    className="rounded p-0.5 text-neutral-600 opacity-0 hover:bg-neutral-800 hover:text-neutral-200 group-hover/repo:opacity-100"
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>

              {expanded && (
                <>
                  {liveName && (
                    <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-neutral-500">
                      <Spinner />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-mono text-neutral-300">
                          {liveName}
                        </span>
                        <span className="mx-1.5 text-neutral-700">·</span>
                        {liveStep ?? "Starting"}…
                      </span>
                    </div>
                  )}

                  <ul>
                    {mainClone && (
                      <li
                        onClick={() => selectWorktree(mainClone.id)}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 py-1 pl-3 pr-2 hover:bg-neutral-900/50",
                          selectedId === mainClone.id && "bg-neutral-900",
                        )}
                        title={mainClone.path}
                      >
                        <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center text-[11px] text-blue-400">
                          ◆
                        </span>
                        <span className="truncate font-mono text-xs text-neutral-100">
                          {mainClone.branch}
                        </span>
                      </li>
                    )}
                    {active.map((w) => renderRow(w, {}))}
                  </ul>

                  {regular.length === 0 && !liveName && (
                    <div className="px-3 py-1.5 text-[11px] text-neutral-600">
                      No worktrees yet — <span className="text-neutral-400">+</span> to create one.
                    </div>
                  )}

                  {inactive.length > 0 && (
                    <>
                      <button
                        onClick={() => toggleIn(setOpenInactive, ws.id)}
                        className="flex w-full items-center gap-1 py-1 pl-3 text-left text-[11px] text-neutral-600 hover:text-neutral-400"
                      >
                        {inactiveOpen ? (
                          <ChevronDown size={11} />
                        ) : (
                          <ChevronRight size={11} />
                        )}
                        {inactive.length} inactive
                      </button>
                      {inactiveOpen && (
                        <ul>{inactive.map((w) => renderRow(w, { dim: true }))}</ul>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-end border-t border-neutral-800 px-3 py-2">
        <button
          onClick={() => void pickAndOpenAnotherRepo()}
          className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
        >
          + Open repo
        </button>
      </div>

      <NewWorktreeDialog
        workspaceId={createDialogWs}
        open={createDialogWs !== null}
        defaultInitSubmodules={initSubmodulesDefault}
        onCreate={(name, base, opts) => {
          if (createDialogWs) void handleCreate(createDialogWs, name, base, opts);
        }}
        onClose={() => closeCreateDialog()}
      />

      {mergeTarget && (
        <MergeDialog
          worktree={mergeTarget}
          defaultBranch={defaultBranchFor(mergeTarget)}
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
          defaultBranch={defaultBranchFor(syncTarget)}
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

function basenameOf(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
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
    <div
      ref={ref}
      data-open={open || undefined}
      className="relative shrink-0"
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn(
          "rounded px-1.5 py-0.5 text-xs leading-none text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200",
          open
            ? "block bg-neutral-800 text-neutral-100"
            : "hidden group-hover:block",
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

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="border-t border-neutral-800 px-3 py-1.5 text-[11px] uppercase tracking-wider text-neutral-600">
      {label} ({count})
    </div>
  );
}

/// Compact per-repo agent tally for the section header: ⚠ blocked,
/// ✓ finished, ⟳ working. Zero counts are omitted.
function RepoStatus({ counts }: { counts: StatusCounts }) {
  const parts: [number, React.ReactNode, string][] = [
    [counts.needsAttention, <AlertTriangle size={10} className="text-amber-400" />, "needs attention"],
    [counts.idle, <Check size={10} className="text-emerald-400" />, "idle"],
    [counts.working, <Loader2 size={10} className="text-sky-400" />, "working"],
  ];
  const shown = parts.filter(([n]) => n > 0);
  if (shown.length === 0) return null;
  return (
    <span className="ml-1 flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-neutral-500">
      {shown.map(([n, icon, label]) => (
        <span key={label} className="flex items-center gap-0.5" title={`${n} ${label}`}>
          {icon}
          {n}
        </span>
      ))}
    </span>
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

/// Per-worktree agent activity glyph. Spinner while output is flowing,
/// green check when it briefly stops (rendering / between turns), amber
/// triangle once it's been quiet long enough that it's almost certainly
/// awaiting input. A small empty dot when there's no agent attached so
/// the row's leading slot stays visually anchored.
function StatusDot({
  activity,
  className,
}: {
  activity: AgentActivity;
  className?: string;
}) {
  const wrapper = "inline-flex h-3 w-3 shrink-0 items-center justify-center";
  switch (activity) {
    case "working":
      return (
        <span title="agent: working" className={cn(wrapper, className)}>
          <Loader2 size={12} className="animate-spin text-sky-400" />
        </span>
      );
    case "idle":
      return (
        <span title="agent: idle" className={cn(wrapper, className)}>
          <Check size={12} className="text-emerald-400" />
        </span>
      );
    case "needsAttention":
      return (
        <span
          title="agent: needs attention"
          className={cn(wrapper, className)}
        >
          <AlertTriangle
            size={12}
            className="animate-pulse text-amber-400"
          />
        </span>
      );
    case "inactive":
    default:
      return (
        <span title="no agent" className={cn(wrapper, className)}>
          <span className="h-1.5 w-1.5 rounded-full bg-neutral-700" />
        </span>
      );
  }
}
