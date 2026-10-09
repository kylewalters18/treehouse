import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, GitCommitHorizontal, GitMerge } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useDiffsStore } from "@/stores/diffs";
import { useActivityStore } from "@/stores/activity";
import type { CommitSummary, WorktreeId } from "@/ipc/types";
import { cn } from "@/lib/cn";
import { countBadge } from "@/lib/pane-chrome";
import { explorerRow } from "./file-icons";
import { ChangedFileTree } from "./ChangedFileTree";
import { Avatar } from "@/components/Avatar";
import { relativeTime } from "@/lib/time";

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
  const rowRef = useRef<HTMLButtonElement>(null);
  const hover = useHoverCard();
  // Selection can come from outside the list (a hash linked in an agent
  // reply); bring the row into view.
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return (
    <li>
      <button
        ref={rowRef}
        onClick={onSelect}
        onMouseEnter={hover.enter}
        onMouseLeave={hover.leave}
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
      {hover.open && rowRef.current && (
        <CommitHoverCard
          commit={commit}
          anchor={rowRef.current}
          onEnter={hover.enter}
          onLeave={hover.leave}
          onClose={hover.close}
        />
      )}
    </li>
  );
}

/// Delayed open, short grace period on leave so the pointer can travel
/// from the row into the card (to copy the SHA or scroll a long body).
function useHoverCard() {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return {
    open,
    close: () => {
      clear();
      setOpen(false);
    },
    enter: () => {
      clear();
      if (!open) timer.current = window.setTimeout(() => setOpen(true), 450);
    },
    leave: () => {
      clear();
      timer.current = window.setTimeout(() => setOpen(false), 120);
    },
  };
}

const CARD_WIDTH = 360;
const GAP = 8;
const MARGIN = 8;

/// Rich commit details floating beside the row. Portaled + `position:
/// fixed` so it escapes the history list's scroll clipping; placed right
/// of the row when it fits, else left, and clamped to the viewport.
function CommitHoverCard({
  commit,
  anchor,
  onEnter,
  onLeave,
  onClose,
}: {
  commit: CommitSummary;
  anchor: HTMLElement;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [copied, setCopied] = useState(false);

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const h = cardRef.current?.offsetHeight ?? 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.right + GAP;
    if (left + CARD_WIDTH > vw - MARGIN) left = rect.left - GAP - CARD_WIDTH;
    left = Math.max(MARGIN, Math.min(left, vw - CARD_WIDTH - MARGIN));
    const top = Math.max(MARGIN, Math.min(rect.top, vh - h - MARGIN));
    setPos({ top, left });
  }, [anchor]);

  // Position is a snapshot of the row's rect; drop the card rather than
  // leave it floating when anything but the card itself scrolls.
  useEffect(() => {
    const onScroll = (e: Event) => {
      if (!cardRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const { body, trailers } = splitMessage(commit.message);
  const { filesChanged, insertions, deletions } = commit.stats;
  const date = new Date(commit.time);

  async function copySha() {
    try {
      await navigator.clipboard.writeText(commit.sha);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — nothing useful to surface */
    }
  }

  return createPortal(
    <div
      ref={cardRef}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        width: CARD_WIDTH,
        ...(pos ?? { top: 0, left: 0, visibility: "hidden" }),
      }}
      className="fixed z-50 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900/95 text-neutral-300 shadow-2xl shadow-black/50 backdrop-blur-sm"
    >
      <div className="flex items-center gap-2 border-b border-neutral-800/80 px-3 py-2">
        <Avatar name={commit.author} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[12px] font-medium text-neutral-200">
            {commit.author}
          </div>
          <div
            className="truncate text-[10.5px] text-neutral-500"
            title={date.toISOString()}
          >
            {relativeTime(commit.time)} ·{" "}
            {date.toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </div>
        </div>
        {commit.merge && (
          <span className="flex shrink-0 items-center gap-1 rounded border border-violet-400/25 bg-violet-400/10 px-1.5 py-0.5 text-[10px] text-violet-300">
            <GitMerge size={11} /> merge
          </span>
        )}
      </div>

      <div className="max-h-72 overflow-y-auto px-3 py-2.5">
        <div className="text-[12.5px] font-medium leading-snug text-neutral-100">
          {commit.summary || (
            <span className="italic text-neutral-500">(no message)</span>
          )}
        </div>
        {body && (
          <div className="mt-2 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-neutral-400">
            {body}
          </div>
        )}
        {trailers.length > 0 && (
          <div className="mt-2.5 space-y-0.5 border-t border-neutral-800/80 pt-2">
            {trailers.map(([k, v], i) => (
              <div key={i} className="flex gap-1.5 text-[10.5px]">
                <span className="shrink-0 text-neutral-500">{k}:</span>
                <span className="truncate text-neutral-400">{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-neutral-800/80 bg-neutral-950/40 px-3 py-1.5 font-mono text-[10.5px] tabular-nums">
        <span className="text-neutral-500">
          {filesChanged} file{filesChanged === 1 ? "" : "s"}
        </span>
        <span className="text-emerald-400/90">+{insertions}</span>
        <span className="text-rose-400/90">-{deletions}</span>
        <ChangeBar insertions={insertions} deletions={deletions} />
        <button
          onClick={copySha}
          title="Copy full SHA"
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          {commit.shortSha}
          {copied ? (
            <Check size={11} className="text-emerald-400" />
          ) : (
            <Copy size={11} />
          )}
        </button>
      </div>
    </div>,
    document.body,
  );
}

/// GitHub-style five-block +/- proportion bar.
function ChangeBar({
  insertions,
  deletions,
}: {
  insertions: number;
  deletions: number;
}) {
  const total = insertions + deletions;
  const blocks = 5;
  const add = total ? Math.round((insertions / total) * blocks) : 0;
  const del = total ? Math.min(blocks - add, Math.round((deletions / total) * blocks)) : 0;
  return (
    <span className="flex gap-px">
      {Array.from({ length: blocks }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-2 w-2 rounded-[1px]",
            i < add
              ? "bg-emerald-500/80"
              : i < add + del
                ? "bg-rose-500/80"
                : "bg-neutral-700",
          )}
        />
      ))}
    </span>
  );
}

/// Split a commit message into its body (minus the summary line) and a
/// trailing `Key: value` trailer block (Co-Authored-By, Signed-off-by, …).
export function splitMessage(message: string): {
  body: string;
  trailers: [string, string][];
} {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const rest = lines.slice(1).join("\n").trim();
  if (!rest) return { body: "", trailers: [] };
  const paras = rest.split(/\n\s*\n/);
  const last = paras[paras.length - 1]!.split("\n");
  const trailerRe = /^([A-Za-z][A-Za-z0-9-]*):\s+(.+)$/;
  if (last.every((l) => trailerRe.test(l))) {
    const trailers = last.map((l) => {
      const m = l.match(trailerRe)!;
      return [m[1]!, m[2]!] as [string, string];
    });
    return { body: paras.slice(0, -1).join("\n\n").trim(), trailers };
  }
  return { body: rest, trailers: [] };
}
