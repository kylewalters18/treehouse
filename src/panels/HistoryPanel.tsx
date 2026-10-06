import { useEffect } from "react";
import { GitCommitHorizontal, GitMerge } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useDiffsStore } from "@/stores/diffs";
import { useActivityStore } from "@/stores/activity";
import type { CommitSummary, WorktreeId } from "@/ipc/types";
import { cn } from "@/lib/cn";
import { countBadge } from "@/lib/pane-chrome";
import { explorerRow } from "./file-icons";
import { ChangedFileTree } from "./ChangedFileTree";

/// History tab of the DiffPane sidebar: the branch's commits on top
/// (newest first, down to the merge-base), the open commit's files below.
/// Picking a file shows that commit's diff (parent..commit) in the main
/// pane.
export function HistoryPanel({ worktreeId }: { worktreeId: WorktreeId }) {
  const list = useDiffsStore((s) => s.commitsByWorktree[worktreeId]);
  const selectedSha = useDiffsStore((s) => s.selectedCommit[worktreeId] ?? null);
  const commitDiff = useDiffsStore((s) =>
    selectedSha ? s.commitDiffs[selectedSha] : undefined,
  );
  const diffError = useDiffsStore((s) => s.commitDiffError[worktreeId]);
  const selectedFile = useDiffsStore((s) => s.selectedFile[worktreeId] ?? null);
  const selectedGroup = useDiffsStore((s) => s.selectedGroup[worktreeId]);
  const fetchCommits = useDiffsStore((s) => s.fetchCommits);
  const selectCommit = useDiffsStore((s) => s.selectCommit);
  const selectFile = useDiffsStore((s) => s.selectFile);
  const setView = useDiffsStore((s) => s.setView);

  // Refetch when the branch moves. `ahead` catches commits / resets (ref
  // moves never touch the worktree's files); the branch diff's timestamp
  // catches everything fs_watch sees, including amends that keep `ahead`.
  const ahead = useActivityStore((s) => s.byWorktree[worktreeId]?.ahead);
  const branchComputedAt = useDiffsStore(
    (s) => s.byWorktree[worktreeId]?.computedAt,
  );
  useEffect(() => {
    void fetchCommits(worktreeId).catch(() => {});
  }, [worktreeId, ahead, branchComputedAt, fetchCommits]);

  const commits = list?.commits ?? [];
  const selected = commits.find((c) => c.sha === selectedSha) ?? null;

  if (list && commits.length === 0) {
    return (
      <div className="px-3 py-4 text-[11px] text-neutral-600">
        No commits on this branch yet.
      </div>
    );
  }

  return (
    <PanelGroup direction="vertical" autoSaveId="diff-history-split">
      <Panel defaultSize={45} minSize={15}>
        <ul className="h-full overflow-y-auto py-1">
          {commits.map((c) => (
            <CommitRow
              key={c.sha}
              commit={c}
              selected={c.sha === selectedSha}
              onSelect={() => void selectCommit(worktreeId, c.sha)}
            />
          ))}
          {list?.truncated && (
            <li className="px-3 py-1 text-[10.5px] text-neutral-600">
              Showing the newest {commits.length} commits
            </li>
          )}
          {list && (
            <li
              className="flex items-center gap-2 px-2 py-1 font-mono text-[10.5px] text-neutral-600"
              title={list.anchor}
            >
              <span className="flex w-3.5 justify-center">┴</span>
              base {list.anchor.slice(0, 7)}
            </li>
          )}
        </ul>
      </Panel>
      <PanelResizeHandle className="h-px bg-neutral-800 hover:bg-neutral-700" />
      <Panel minSize={15}>
        <div className="flex h-full flex-col">
          <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-neutral-800/60 px-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-neutral-500">
            <span className="flex min-w-0 items-center gap-1.5">
              Files
              {selected && (
                <span className="font-mono normal-case tracking-normal text-neutral-600">
                  in {selected.shortSha}
                </span>
              )}
            </span>
            {commitDiff && (
              <span className={countBadge("neutral")}>
                {commitDiff.files.length}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!selectedSha ? (
              <div className="px-3 py-4 text-[11px] text-neutral-600">
                Select a commit to see its changes.
              </div>
            ) : diffError ? (
              <div className="m-2 rounded-md border border-rose-400/20 bg-rose-400/[0.06] px-2 py-1.5 text-[11px] text-rose-300">
                {diffError}
              </div>
            ) : !commitDiff ? (
              <div className="px-3 py-4 text-[11px] text-neutral-600">
                Loading…
              </div>
            ) : (
              <ChangedFileTree
                files={commitDiff.files}
                isSelected={(path) =>
                  selectedGroup === "commit" && selectedFile === path
                }
                onSelect={(path) => {
                  selectFile(worktreeId, path, "commit");
                  setView(worktreeId, "diff");
                }}
                className="py-1"
              />
            )}
          </div>
        </div>
      </Panel>
    </PanelGroup>
  );
}

function CommitRow({
  commit,
  selected,
  onSelect,
}: {
  commit: CommitSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const Glyph = commit.merge ? GitMerge : GitCommitHorizontal;
  return (
    <li>
      <button
        onClick={onSelect}
        title={`${commit.message}\n\n${commit.author} · ${new Date(commit.time).toLocaleString()}`}
        className={cn(
          "relative grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2 px-2 py-1 text-left transition-colors",
          explorerRow(selected),
        )}
      >
        <Glyph
          size={14}
          className={selected ? "text-blue-400" : "text-neutral-600"}
        />
        <span className="truncate text-[12px] text-neutral-200">
          {commit.summary || "(no message)"}
        </span>
        <span className="font-mono text-[10.5px] text-neutral-500">
          {commit.shortSha}
        </span>
        <span className="col-start-2 col-end-4 flex gap-2 font-mono text-[10.5px] tabular-nums text-neutral-600">
          <span>{relativeTime(commit.time)}</span>
          <span>
            <span className="text-emerald-400/80">+{commit.stats.insertions}</span>{" "}
            <span className="text-rose-400/80">-{commit.stats.deletions}</span>
          </span>
          <span className="truncate">{commit.author}</span>
        </span>
      </button>
    </li>
  );
}

function relativeTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}
