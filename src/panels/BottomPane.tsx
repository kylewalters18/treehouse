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

import { ProblemsList, useProblemsCount } from "@/components/ProblemsList";
import { TerminalPane } from "@/panels/TerminalPane";
import { useUiStore } from "@/stores/ui";
import { cn } from "@/lib/cn";

export function BottomPane() {
  const tab = useUiStore((s) => s.bottomPaneTab);
  const setTab = useUiStore((s) => s.setBottomPaneTab);
  const problemsCount = useProblemsCount();

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
    </div>
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
