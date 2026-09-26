import { GitBranch, Loader2 } from "lucide-react";
import { useActivityStore } from "@/stores/activity";
import { useLspStore } from "@/stores/lsp";
import { useUiStore } from "@/stores/ui";
import type { Worktree } from "@/ipc/types";

/// Bottom status strip: selected worktree's branch + ahead/behind on the
/// left, cross-repo agent tallies and language-server progress on the
/// right. Read-only — every value mirrors a store the rest of the app
/// already keeps fresh.
export function StatusBar({
  worktree,
  defaultBranch,
}: {
  worktree: Worktree | null;
  defaultBranch: string | null;
}) {
  const activity = useActivityStore((s) => s.byWorktree);
  const focusMode = useUiStore((s) => s.focusMode);
  const progress = useLspStore((s) => s.progress);

  const a = worktree ? activity[worktree.id] : undefined;
  let working = 0;
  let needsYou = 0;
  for (const w of Object.values(activity)) {
    if (w.activity === "working") working++;
    else if (w.activity === "needsAttention") needsYou++;
  }

  // First in-flight progress report for the selected worktree's servers.
  // Keys are `${worktreeId}::${languageId}` (see lsp store).
  const lsp = worktree
    ? Object.entries(progress).find(
        ([k, p]) => p && k.startsWith(`${worktree.id}::`),
      )
    : undefined;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-neutral-800 bg-chrome px-3 text-[11px] text-neutral-500">
      {worktree ? (
        <>
          <span className="flex min-w-0 items-center gap-1.5">
            <GitBranch size={12} className="shrink-0" />
            <span className="truncate font-mono text-neutral-300">
              {worktree.branch}
            </span>
            {a?.dirty && (
              <span className="text-amber-400" title="Uncommitted changes">
                ●
              </span>
            )}
          </span>
          {!worktree.isMainClone && (
            <span
              className="shrink-0 tabular-nums"
              title={`Ahead / behind ${defaultBranch ?? "default branch"}`}
            >
              ↑{a?.ahead ?? 0} ↓{a?.behind ?? 0}
              {defaultBranch && (
                <span className="ml-1.5 font-mono text-neutral-600">
                  vs {defaultBranch}
                </span>
              )}
            </span>
          )}
        </>
      ) : (
        <span>No worktree selected</span>
      )}
      {focusMode && (
        <span className="shrink-0 text-blue-400">focus · ⌘\ to exit</span>
      )}
      <span className="flex-1" />
      {lsp && lsp[1] && (
        <span className="flex min-w-0 items-center gap-1.5">
          <Loader2 size={11} className="shrink-0 animate-spin" />
          <span className="truncate">
            {lsp[0].split("::")[1]}: {lsp[1].title}
            {lsp[1].percentage != null && ` ${lsp[1].percentage}%`}
          </span>
        </span>
      )}
      {working > 0 && (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
          {working} working
        </span>
      )}
      {needsYou > 0 && (
        <span className="flex shrink-0 items-center gap-1.5 text-amber-400">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          {needsYou} need{needsYou === 1 ? "s" : ""} you
        </span>
      )}
    </footer>
  );
}
