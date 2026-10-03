import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  Home,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  X,
} from "lucide-react";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import { useUiStore } from "@/stores/ui";
import { useActivityStore } from "@/stores/activity";
import { useSettingsStore } from "@/stores/settings";
import { usePinsStore } from "@/stores/pins";
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
import { iconButton } from "@/lib/pane-chrome";
import { runWorktreeSetup } from "@/lib/worktree-setup";
import {
  inboxWorktrees,
  nextAcks,
  pinnedWorktrees,
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
  const startAgentDefault = useSettingsStore(
    (s) => s.settings.autoStartAgent,
  );
  const initSubmodulesDefault = useSettingsStore(
    (s) => s.settings.initSubmodules,
  );
  const activity = useActivityStore((s) => s.byWorktree);
  const pinnedPaths = usePinsStore((s) => s.paths);
  const loadPins = usePinsStore((s) => s.load);
  const setPinned = usePinsStore((s) => s.setPinned);
  const setActivity = useActivityStore((s) => s.setAll);
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
    void loadPins();
  }, [loadPins]);

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
    opts: { initSubmodules: boolean; runSetup: boolean; startAgent: boolean },
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
        // Flag before selecting so the AgentPane that mounts for the new
        // worktree sees it on its first adoption pass.
        if (opts.startAgent) {
          useUiStore.getState().requestAgentLaunchFor(wt.id);
        }
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
    // Always confirm — the ✕ sits right next to the repo name and one
    // stray click tears down every agent, terminal, and LSP in the repo.
    // Live agents / dirty worktrees are called out when present.
    const repoWorktrees = worktrees.filter((w) => w.workspaceId === ws.id);
    const liveAgents = repoWorktrees.filter(
      (w) => activity[w.id] !== undefined && activity[w.id].activity !== "inactive",
    );
    const dirty = repoWorktrees.filter((w) => activity[w.id]?.dirty);
    const reasons: string[] = [];
    if (liveAgents.length > 0)
      reasons.push(`• ${liveAgents.length} live agent(s) will be killed`);
    if (dirty.length > 0)
      reasons.push(`• ${dirty.length} worktree(s) have uncommitted changes`);
    const repoLabel = basenameOf(ws.root);
    // Not `window.confirm`: tauri-plugin-dialog replaces it with an async
    // version whose Promise is always truthy, so the guard never held.
    const ok = await ask(
      `Close "${repoLabel}"?\n\n${ws.root}\n\n` +
        (reasons.length ? `${reasons.join("\n")}\n\n` : "") +
        "Open agents and terminals will be closed. The on-disk worktrees are kept; this just detaches them from treehouse.",
      { title: "Close repo", kind: "warning", okLabel: "Close" },
    );
    if (!ok) return;
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
    const ok = await ask(lead + tail, {
      title: "Remove worktree",
      kind: "warning",
      okLabel: "Remove",
    });
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
  // The main clone can host agents too, so it's eligible for the inbox.
  const inbox = inboxWorktrees(worktrees, activity, acks);
  // Pinned worktrees are hoisted out of their repo's list (they still
  // show in "Needs you" when their agent does).
  const pinned = pinnedWorktrees(worktrees, pinnedPaths);
  const isPinned = (w: Worktree) => pinnedPaths.includes(w.path);
  const repoName = (w: Worktree) =>
    basenameOf(workspaces.find((ws) => ws.id === w.workspaceId)?.root ?? "");

  if (collapsed) {
    // Collapsed rail mirrors the expanded layout row for row: chrome
    // header, amber "Needs you" band, then per repo a sticky RepoMark
    // header (click folds the repo, same state as the expanded header),
    // main clone + active worktrees, and the same "inactive" pile.
    const renderDot = (w: Worktree, opts: { dim?: boolean } = {}) => {
      const a = activity[w.id];
      const act = a?.activity ?? "inactive";
      const tooltip =
        (showRepoChips ? `${repoName(w)} · ` : "") +
        w.branch +
        (w.isMainClone ? "  (main clone)" : "") +
        (a?.ahead ? `  ↑${a.ahead}` : "") +
        (a?.behind ? `  ↓${a.behind}` : "");
      return (
        <RailButton
          key={w.id}
          tooltip={tooltip}
          onClick={() => selectWorktree(w.id)}
          selected={selectedId === w.id}
        >
          <span className={cn("relative flex", opts.dim && "opacity-60")}>
            {/* Main clone: the Home glyph the expanded row uses stands
                in for the empty "no agent" dot; with an agent running,
                it shrinks to a corner badge on the status icon. */}
            {w.isMainClone && act === "inactive" ? (
              <Home size={12} className="text-neutral-500" />
            ) : (
              <StatusDot activity={act} />
            )}
            {w.isMainClone && act !== "inactive" && (
              <Home
                size={8}
                strokeWidth={2.5}
                className="absolute -bottom-1 -right-1.5 text-neutral-400"
              />
            )}
          </span>
        </RailButton>
      );
    };
    return (
      <div className="flex h-full flex-col border-r border-neutral-800">
        <div className="flex h-[34px] shrink-0 items-center justify-center border-b border-neutral-800 bg-chrome">
          <button
            onClick={toggleCollapsed}
            title="Expand sidebar (⌘B)"
            aria-label="Expand sidebar"
            className={iconButton}
          >
            <PanelLeftOpen size={14} />
          </button>
        </div>
        {/* Fixed above the scroll area so they never scroll away. */}
        {inbox.length > 0 && (
          <div className="relative shrink-0 border-b border-amber-400/25 bg-amber-400/[0.06] before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-amber-400/60 py-1">
            {inbox.map((w) => renderDot(w))}
          </div>
        )}
        {pinned.length > 0 && (
          <div className="shrink-0 border-b border-neutral-800 py-1">
            {pinned.map((w) => renderDot(w))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {workspaces.map((ws) => {
            const repoWorktrees = worktrees.filter(
              (w) => w.workspaceId === ws.id,
            );
            const mainClone =
              repoWorktrees.find((w) => w.isMainClone && !isPinned(w)) ??
              null;
            const { active, inactive } = splitActive(
              repoWorktrees.filter((w) => !w.isMainClone && !isPinned(w)),
              activity,
            );
            const name = basenameOf(ws.root);
            const expanded = !collapsedRepos.has(ws.id);
            const inactiveOpen = openInactive.has(ws.id);
            // The selected worktree stays visible even while the pile
            // is shut, so the rail never loses track of where you are.
            const shownInactive = inactiveOpen
              ? inactive
              : inactive.filter((w) => w.id === selectedId);
            const hiddenCount = inactive.length - shownInactive.length;
            return (
              <div
                key={ws.id}
                className={cn("border-b border-neutral-800", expanded && "pb-1")}
              >
                <RailButton
                  tooltip={`${name} · ${expanded ? "collapse" : "expand"}`}
                  onClick={() => toggleIn(setCollapsedRepos, ws.id)}
                  className={cn(
                    "sticky top-0 z-10 h-8 bg-neutral-900 hover:bg-[#1A1D21]",
                    expanded && "mb-1 border-b border-neutral-800",
                  )}
                >
                  <RepoMark name={name} />
                </RailButton>
                {expanded && (
                  <>
                    {mainClone && renderDot(mainClone)}
                    {active.map((w) => renderDot(w))}
                    {shownInactive.map((w) => renderDot(w, { dim: true }))}
                    {inactive.length > 0 && (
                      <RailButton
                        tooltip={
                          inactiveOpen
                            ? `Hide ${inactive.length} inactive`
                            : `Show ${hiddenCount} inactive`
                        }
                        onClick={() => toggleIn(setOpenInactive, ws.id)}
                        className="h-6 text-[10px] text-neutral-600 hover:text-neutral-400"
                      >
                        {inactiveOpen ? (
                          <ChevronDown size={11} />
                        ) : (
                          <>
                            <ChevronRight size={11} />
                            {hiddenCount > 0 && hiddenCount}
                          </>
                        )}
                      </RailButton>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const renderRow = (w: Worktree, opts: { dim?: boolean; chip?: boolean }) => {
    const a = activity[w.id];
    return (
      <li
        key={w.id}
        className={cn(
          // Fixed height, not padding: the hover swap (badges → ⋯) trades
          // content of slightly different heights, which made the row jump.
          "group relative flex cursor-pointer items-center pl-3 pr-1 hover:bg-neutral-900/60",
          // Rows with a repo line ("Needs you" / Pinned, multi-repo) get
          // a second line instead of a `repo /` prefix eating the branch.
          opts.chip ? "h-10" : "h-7",
          selectedId === w.id &&
            "bg-blue-400/[0.08] hover:bg-blue-400/[0.1] before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:rounded-r before:bg-blue-400",
        )}
        onClick={() => selectWorktree(w.id)}
        aria-current={selectedId === w.id ? "true" : undefined}
        title={
          w.createdBy
            ? `${w.path}\nCreated by the agent in ${w.createdBy}`
            : w.path
        }
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
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-mono text-xs text-neutral-200">
              {w.branch}
            </span>
            {/* Repo name only — keep this line from growing into a
                status/metadata slot. */}
            {opts.chip && (
              <span
                className="flex min-w-0 items-center gap-1 text-[10.5px] leading-4 text-neutral-500"
                title={repoName(w)}
              >
                <RepoMark name={repoName(w)} size="sm" />
                <span className="truncate">{repoName(w)}</span>
              </span>
            )}
          </span>
          {/* Badges give way to the ⋯ menu on hover (and while it's
              open) so the one-line row never has to fit both. */}
          <span
            className={cn(
              "flex min-w-0 shrink items-center gap-2",
              !w.isMainClone &&
                "group-hover:hidden group-has-[[data-open]]:hidden",
            )}
          >
            {/* Spawned by another worktree's agent over MCP. Shrinks
                (and truncates) before the branch name does. */}
            {w.createdBy && (
              <span className="min-w-0 max-w-[8rem] shrink truncate font-mono text-[10px] text-neutral-600">
                ↳ {w.createdBy}
              </span>
            )}
            {(a?.agentCount ?? 0) > 1 && (
              <span
                className="shrink-0 font-mono text-[10px] text-neutral-500"
                title={`${a?.agentCount} agents`}
              >
                ×{a?.agentCount}
              </span>
            )}
            <span className="shrink-0">
              <AheadBehind ahead={a?.ahead ?? 0} behind={a?.behind ?? 0} />
            </span>
            {/* The main clone has no ⋯ menu (merge / sync / remove don't
                apply), so its badges stay put and the right slot carries
                the "repo root" marker instead. */}
            {w.isMainClone && (
              <span
                className="shrink-0 pr-1 text-neutral-500"
                title="Main clone (repo root)"
              >
                <Home size={12} />
              </span>
            )}
          </span>
        </div>
        <PinToggle
          pinned={isPinned(w)}
          onToggle={() => void setPinned(w.path, !isPinned(w))}
        />
        {!w.isMainClone && (
          <RowMenu
            behind={a?.behind ?? 0}
            onSync={() => setSyncTarget(w)}
            onMerge={() => setMergeTarget(w)}
            onRemove={() => onRemove(w)}
          />
        )}
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
      <div className="flex h-[34px] shrink-0 items-center justify-between border-b border-neutral-800 bg-chrome px-3">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
          {showRepoChips ? "Repos" : "Worktrees"}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-neutral-600">{allRegular.length}</span>
          <button
            onClick={toggleCollapsed}
            title="Collapse sidebar (⌘B)"
            aria-label="Collapse sidebar"
            className={iconButton}
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* Pinned above the scroll area so it stays visible however many
          worktrees there are. Deliberately not its own scroller: overflow
          would clip RowMenu's absolutely-positioned dropdown. */}
      {inbox.length > 0 && (
        <div className="relative z-30 shrink-0 border-b border-amber-400/25 bg-amber-400/[0.06] before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-amber-400/60 pb-1">
          <SectionHeader label="Needs you" count={inbox.length} />
          <ul>{inbox.map((w) => renderRow(w, { chip: showRepoChips }))}</ul>
        </div>
      )}
      {/* Same treatment as "Needs you": fixed, not scrolling. Stacks
          under it (lower z) so its row menus can overlap this band. */}
      {pinned.length > 0 && (
        <div className="relative z-20 shrink-0 border-b border-neutral-800 pb-1">
          <SectionHeader label="Pinned" count={pinned.length} tone="neutral" />
          <ul>{pinned.map((w) => renderRow(w, { chip: showRepoChips }))}</ul>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">

        {workspaces.map((ws) => {
          const repoWorktrees = worktrees.filter(
            (w) => w.workspaceId === ws.id,
          );
          const mainClone =
            repoWorktrees.find((w) => w.isMainClone && !isPinned(w)) ?? null;
          const regular = repoWorktrees.filter((w) => !w.isMainClone);
          const { active, inactive } = splitActive(
            regular.filter((w) => !isPinned(w)),
            activity,
          );
          const liveName = creatingNames[ws.id];
          const liveStep = creatingSteps[ws.id];
          const expanded = !collapsedRepos.has(ws.id);
          const inactiveOpen = openInactive.has(ws.id);
          return (
            <div
              key={ws.id}
              className={cn("border-b border-neutral-800", expanded && "pb-1.5")}
            >
              {/* Sticky so a long repo keeps its name in view while you
                  scroll its worktrees. Opaque background required. */}
              <div
                role="button"
                onClick={() => toggleIn(setCollapsedRepos, ws.id)}
                className={cn(
                  "group/repo sticky top-0 z-10 flex h-8 w-full cursor-pointer items-center justify-between gap-2 bg-neutral-900 px-2 hover:bg-[#1A1D21]",
                  expanded && "mb-1 border-b border-neutral-800",
                )}
                title={ws.root}
              >
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  {expanded ? (
                    <ChevronDown size={12} className="shrink-0 text-neutral-500" />
                  ) : (
                    <ChevronRight size={12} className="shrink-0 text-neutral-500" />
                  )}
                  <RepoMark name={basenameOf(ws.root)} />
                  <span className="truncate text-xs font-semibold text-neutral-100">
                    {basenameOf(ws.root)}
                  </span>
                  <RepoStatus counts={statusCounts(repoWorktrees, activity)} />
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
                    {mainClone && renderRow(mainClone, {})}
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

      <div className="flex items-center justify-end border-t border-neutral-800 px-2 py-2">
        <button
          onClick={() => void pickAndOpenAnotherRepo()}
          className="flex h-6 w-full items-center justify-center gap-1 rounded-md border border-neutral-700 bg-neutral-900 text-[11px] text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
        >
          <Plus size={12} />
          Open repo
        </button>
      </div>

      <NewWorktreeDialog
        workspaceId={createDialogWs}
        open={createDialogWs !== null}
        defaultInitSubmodules={initSubmodulesDefault}
        defaultStartAgent={startAgentDefault}
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
  selected = false,
  className,
  children,
}: {
  tooltip: string;
  onClick: () => void;
  selected?: boolean;
  className?: string;
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
        aria-label={tooltip}
        aria-current={selected ? "true" : undefined}
        className={cn(
          // Full-width row with the expanded row's hover + selection
          // treatment (blue tint, 2px accent bar on the left edge).
          "relative flex h-7 w-full items-center justify-center gap-0.5 hover:bg-neutral-900/60",
          selected &&
            "bg-blue-400/[0.08] hover:bg-blue-400/[0.1] before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:rounded-r before:bg-blue-400",
          className,
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

function SectionHeader({
  label,
  count,
  tone = "amber",
}: {
  label: string;
  count: number;
  tone?: "amber" | "neutral";
}) {
  return (
    <div
      className={cn(
        "flex h-7 items-center gap-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.08em]",
        tone === "amber" ? "text-amber-400/80" : "text-neutral-500",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 font-mono text-[10px] font-medium leading-4 tracking-normal",
          tone === "amber"
            ? "bg-amber-400/15 text-amber-400"
            : "bg-neutral-800 text-neutral-400",
        )}
      >
        {count}
      </span>
    </div>
  );
}

/// Hover-revealed pin button, beside the ⋯ menu where a row has one.
/// Also shown while that menu is open, when the row's badges are hidden.
function PinToggle({
  pinned,
  onToggle,
}: {
  pinned: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      title={pinned ? "Unpin" : "Pin to top"}
      aria-label={pinned ? "Unpin" : "Pin to top"}
      className="hidden shrink-0 rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 group-hover:block group-has-[[data-open]]:block"
    >
      {pinned ? <PinOff size={12} /> : <Pin size={12} />}
    </button>
  );
}

/// Compact per-repo agent tally for the section header: ⚠ blocked,
/// ✓ finished, ⟳ working. Zero counts are omitted.
function RepoStatus({ counts }: { counts: StatusCounts }) {
  const parts: [number, React.ReactNode, string][] = [
    [counts.needsAttention, <AlertTriangle size={10} className="text-amber-400" />, "needs attention"],
    [counts.idle, <Check size={10} className="text-emerald-400" />, "idle"],
    [counts.working, <Loader2 size={10} className="text-blue-400" />, "working"],
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

/// Tints for repo marks. Deliberately avoids emerald / amber / rose,
/// which carry agent state elsewhere in the sidebar. Full class strings
/// so Tailwind's scanner keeps them.
const REPO_TINTS = [
  "bg-violet-400/15 text-violet-300",
  "bg-cyan-400/15 text-cyan-300",
  "bg-fuchsia-400/15 text-fuchsia-300",
  "bg-indigo-400/20 text-indigo-300",
  "bg-sky-400/15 text-sky-300",
  "bg-pink-400/15 text-pink-300",
];

/// Small tinted tile identifying a repo. The tint is hashed from the
/// name, so a repo keeps its color across sessions.
function RepoMark({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md";
}) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded",
        size === "sm" ? "h-3 w-3" : "h-4 w-4",
        REPO_TINTS[Math.abs(h) % REPO_TINTS.length],
      )}
    >
      <FolderGit2 size={size === "sm" ? 9 : 11} strokeWidth={2.25} />
    </span>
  );
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
          <Loader2 size={12} className="animate-spin text-blue-400" />
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
