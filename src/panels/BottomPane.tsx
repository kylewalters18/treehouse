/// VS Code-style bottom panel: terminal and Problems share the
/// same vertical slot, switched via a tab strip at the top.
///
/// Both views stay mounted at all times — flipping to Problems
/// hides the terminal via CSS rather than unmounting it, so xterm
/// sessions, scrollback, agent attach state, etc. all survive
/// without going through a fresh attach cycle. Problems is a
/// pure view of Monaco's marker registry, so it has no state of
/// its own to preserve, but the symmetry keeps the implementation
/// uniform.

import { useEffect } from "react";
import { ProblemsList, useProblemsCount } from "@/components/ProblemsList";
import { TerminalPane } from "@/panels/TerminalPane";
import { CIPanel } from "@/panels/CIPanel";
import { ReviewPanel } from "@/panels/ReviewPanel";
import { useForgeStore, forgeBranchKey } from "@/stores/forge";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { workspaceForWorktree } from "@/stores/workspace";
import { cn } from "@/lib/cn";

/// Counts for the Review / CI tab badges. Derived reactively from the forge
/// store, so an action elsewhere (resolving a thread in the Review tab,
/// retrying a pipeline in the CI tab) updates the badge immediately — the
/// store is the single source. A 20s poll only keeps that store fresh for
/// changes made outside the app. Non-forge / unauth / GitHub repos error
/// instantly (no process spawned) → zero.
function useForgeBadges(): { unresolved: number; failedJobs: number } {
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const selected = worktrees.find((w) => w.id === selectedWorktreeId) ?? null;
  const workspace = workspaceForWorktree(selected?.workspaceId);
  const wsId = workspace?.id ?? null;
  const branch = selected?.branch ?? null;

  const findMr = useForgeStore((s) => s.findMr);
  const loadThreads = useForgeStore((s) => s.loadThreads);
  const loadPipelines = useForgeStore((s) => s.loadPipelines);
  const loadJobs = useForgeStore((s) => s.loadJobs);

  // Reactive reads — these recompute whenever the store changes.
  const mr = useForgeStore((s) =>
    wsId && branch ? s.mrByBranch[forgeBranchKey(wsId, branch)] : undefined,
  );
  const threads = useForgeStore((s) =>
    wsId && mr ? s.threadsByMr[`${wsId}::mr::${mr.number}`] : undefined,
  );
  const pipelines = useForgeStore((s) =>
    wsId && branch ? s.pipelinesByBranch[forgeBranchKey(wsId, branch)] : undefined,
  );
  const latest = pipelines?.[0];
  const jobs = useForgeStore((s) => (latest ? s.jobsByPipeline[latest.id] : undefined));

  const unresolved = (threads ?? []).filter((t) => t.resolvable && !t.resolved).length;
  const failedJobs =
    latest && latest.status === "failed"
      ? (jobs ?? []).filter((j) => !j.retried && j.status === "failed").length
      : 0;

  // Poll to keep the store fresh (the counts above react to it).
  useEffect(() => {
    if (!wsId || !branch) return;
    async function tick() {
      try {
        const m = await findMr(wsId!, branch!);
        if (m) await loadThreads(wsId!, m.number);
        await loadPipelines(wsId!, branch!);
        const ps = useForgeStore.getState().pipelinesByBranch[forgeBranchKey(wsId!, branch!)];
        const lt = ps?.[0];
        if (lt && lt.status === "failed") await loadJobs(wsId!, lt.id);
      } catch {
        // ignore — no forge / not authed / not implemented
      }
    }
    void tick();
    const h = window.setInterval(tick, 20000);
    return () => window.clearInterval(h);
  }, [wsId, branch, findMr, loadThreads, loadPipelines, loadJobs]);

  return { unresolved, failedJobs };
}

export function BottomPane() {
  const tab = useUiStore((s) => s.bottomPaneTab);
  const setTab = useUiStore((s) => s.setBottomPaneTab);
  const problemsCount = useProblemsCount();
  const { unresolved, failedJobs } = useForgeBadges();

  return (
    <div className="flex h-full flex-col bg-neutral-950">
      <div className="flex shrink-0 items-center gap-1 border-b border-neutral-900 px-2 py-1">
        <TabButton
          active={tab === "terminal"}
          onClick={() => setTab("terminal")}
        >
          Terminal
        </TabButton>
        <TabButton
          active={tab === "problems"}
          onClick={() => setTab("problems")}
        >
          Problems
          {problemsCount > 0 && (
            <span
              className={cn(
                "ml-1.5 rounded-full px-1.5 py-[1px] text-[10px] font-semibold",
                tab === "problems"
                  ? "bg-blue-700 text-blue-100"
                  : "bg-neutral-700 text-neutral-200",
              )}
            >
              {problemsCount}
            </span>
          )}
        </TabButton>
        <TabButton active={tab === "review"} onClick={() => setTab("review")}>
          Review
          {unresolved > 0 && (
            <TabBadge active={tab === "review"}>{unresolved}</TabBadge>
          )}
        </TabButton>
        <TabButton active={tab === "ci"} onClick={() => setTab("ci")}>
          CI
          {failedJobs > 0 && (
            <TabBadge active={tab === "ci"} danger>
              {failedJobs}
            </TabBadge>
          )}
        </TabButton>
      </div>
      {/* Both views stay mounted; the inactive one is `display:
          none` so xterm sessions, scrollback, agent state, etc.
          aren't torn down on tab flip. xterm-fit re-measures via
          ResizeObserver when the host transitions from 0-sized
          back to visible. */}
      <div className={cn("flex-1 min-h-0", tab !== "terminal" && "hidden")}>
        <TerminalPane />
      </div>
      <div className={cn("flex-1 min-h-0", tab !== "problems" && "hidden")}>
        <ProblemsList />
      </div>
      {/* Review + CI mount only when active — they hit the forge, so we don't
          want them fetching in the background behind the terminal. */}
      {tab === "review" && (
        <div className="flex-1 min-h-0">
          <ReviewPanel />
        </div>
      )}
      {tab === "ci" && (
        <div className="flex-1 min-h-0">
          <CIPanel />
        </div>
      )}
    </div>
  );
}

/// Count pill on a tab — red for CI failures, blue-when-active / neutral
/// otherwise (matching the Problems badge).
function TabBadge({
  active,
  danger,
  children,
}: {
  active: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "ml-1.5 rounded-full px-1.5 py-[1px] text-[10px] font-semibold",
        danger
          ? "bg-red-700 text-red-100"
          : active
            ? "bg-blue-700 text-blue-100"
            : "bg-neutral-700 text-neutral-200",
      )}
    >
      {children}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center rounded px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors",
        active
          ? "bg-neutral-800 text-neutral-100"
          : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300",
      )}
    >
      {children}
    </button>
  );
}
