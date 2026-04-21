import { useEffect, useMemo, useState } from "react";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { useDiffsStore } from "@/stores/diffs";
import { onDiffUpdated } from "@/ipc/client";
import type { DiffLine, FileDiff, FileStatus, WorktreeId } from "@/ipc/types";
import { cn } from "@/lib/cn";
import { EditorPane } from "./EditorPane";
import { FileTree } from "./FileTree";

export function DiffPane() {
  const worktreeId = useUiStore((s) => s.selectedWorktreeId);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const worktree = useMemo(
    () => worktrees.find((w) => w.id === worktreeId) ?? null,
    [worktrees, worktreeId],
  );

  if (!worktree) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-neutral-600">
        Select a worktree to see its diff
      </div>
    );
  }

  return <DiffView worktreeId={worktree.id} />;
}

function DiffView({ worktreeId }: { worktreeId: WorktreeId }) {
  const diff = useDiffsStore((s) => s.byWorktree[worktreeId]);
  const error = useDiffsStore((s) => s.error[worktreeId]);
  const selectedFile = useDiffsStore((s) => s.selectedFile[worktreeId] ?? null);
  const view = useDiffsStore((s) => s.view[worktreeId] ?? "diff");
  const fetchDiff = useDiffsStore((s) => s.fetch);
  const setDiff = useDiffsStore((s) => s.set);
  const selectFile = useDiffsStore((s) => s.selectFile);
  const setView = useDiffsStore((s) => s.setView);
  const [treeRefresh, setTreeRefresh] = useState(0);

  useEffect(() => {
    fetchDiff(worktreeId);
    const p = onDiffUpdated(worktreeId, (d) => {
      setDiff(worktreeId, d);
      setTreeRefresh((n) => n + 1);
    });
    return () => {
      p.then((fn) => fn()).catch(() => {});
    };
  }, [worktreeId, fetchDiff, setDiff]);

  const statusByPath = useMemo<Map<string, FileStatus>>(() => {
    const m = new Map<string, FileStatus>();
    if (diff) {
      for (const f of diff.files) m.set(f.path, f.status);
    }
    return m;
  }, [diff]);

  const selected: FileDiff | null = useMemo(() => {
    if (!diff || !selectedFile) return null;
    return diff.files.find((f) => f.path === selectedFile) ?? null;
  }, [diff, selectedFile]);

  // If the user picks a file from the tree that isn't in the diff, force the
  // File tab since there's no diff to show.
  useEffect(() => {
    if (!selectedFile) return;
    const inDiff = diff?.files.some((f) => f.path === selectedFile) ?? false;
    if (!inDiff && view !== "file") setView(worktreeId, "file");
  }, [selectedFile, diff, view, worktreeId, setView]);

  if (error) {
    return (
      <div className="m-3 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-72 flex-col border-r border-neutral-800">
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-900 px-3 py-2 text-[11px] uppercase tracking-wider text-neutral-500">
          <span>Changes ({diff?.stats.filesChanged ?? 0})</span>
          {diff && (
            <span className="font-mono text-[10px]">
              <span className="text-emerald-400">+{diff.stats.insertions}</span>{" "}
              <span className="text-rose-400">-{diff.stats.deletions}</span>
            </span>
          )}
        </div>
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-neutral-900">
          {!diff || diff.files.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-neutral-600">
              {diff
                ? `No changes against ${diff.baseRef.slice(0, 8)}`
                : "Computing diff…"}
            </div>
          ) : (
            <ul>
              {diff.files.map((f) => (
                <li key={f.path}>
                  <button
                    onClick={() => {
                      selectFile(worktreeId, f.path);
                      setView(worktreeId, "diff");
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1 text-left text-xs hover:bg-neutral-900",
                      selectedFile === f.path && "bg-neutral-900",
                    )}
                    title={f.path}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <StatusBadge status={f.status} />
                      <span className="truncate font-mono text-[11px] text-neutral-200">
                        {f.path}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px]">
                      <span className="text-emerald-400">+{f.insertions}</span>{" "}
                      <span className="text-rose-400">-{f.deletions}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center border-b border-neutral-900 px-3 py-2 text-[11px] uppercase tracking-wider text-neutral-500">
          Files
        </div>
        <div className="flex-1 overflow-y-auto">
          <FileTree
            worktreeId={worktreeId}
            statusByPath={statusByPath}
            selectedPath={selectedFile}
            onSelect={(path) => selectFile(worktreeId, path)}
            refreshToken={treeRefresh}
          />
        </div>
      </aside>
      <section className="flex flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-950 px-2 py-1 text-[11px]">
          <TabButton
            active={view === "diff"}
            onClick={() => setView(worktreeId, "diff")}
            disabled={!selected}
          >
            Diff
          </TabButton>
          <TabButton
            active={view === "file"}
            onClick={() => setView(worktreeId, "file")}
            disabled={
              !selectedFile ||
              (selected?.binary ?? false) ||
              selected?.status.kind === "deleted"
            }
          >
            File
          </TabButton>
          {selectedFile && (
            <span className="ml-2 min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-500">
              {selectedFile}
            </span>
          )}
          <FocusToggle />
        </div>
        <div className="flex-1 overflow-auto">
          {!selectedFile ? (
            <div className="flex h-full items-center justify-center text-xs text-neutral-600">
              Select a file
            </div>
          ) : view === "file" ? (
            <EditorPane worktreeId={worktreeId} path={selectedFile} />
          ) : selected ? (
            <HunksView file={selected} />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-neutral-600">
              No diff for this file — switch to the File tab
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function FocusToggle() {
  const focusMode = useUiStore((s) => s.focusMode);
  const toggle = useUiStore((s) => s.toggleFocusMode);
  return (
    <button
      onClick={toggle}
      title={focusMode ? "Exit focus mode (⌘\\)" : "Focus mode (⌘\\)"}
      className={cn(
        "ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium",
        focusMode
          ? "bg-blue-900/50 text-blue-200 hover:bg-blue-900/70"
          : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200",
      )}
    >
      {focusMode ? "⤡" : "⤢"}
    </button>
  );
}

function TabButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded px-2 py-0.5 text-[11px] font-medium",
        active
          ? "bg-neutral-800 text-neutral-100"
          : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-neutral-400",
      )}
    >
      {children}
    </button>
  );
}

function StatusBadge({ status }: { status: FileStatus }) {
  const kind = status.kind;
  const map: Record<string, { label: string; cls: string }> = {
    added: { label: "A", cls: "bg-emerald-900/50 text-emerald-300" },
    modified: { label: "M", cls: "bg-amber-900/50 text-amber-300" },
    deleted: { label: "D", cls: "bg-rose-900/50 text-rose-300" },
    renamed: { label: "R", cls: "bg-blue-900/50 text-blue-300" },
    untracked: { label: "?", cls: "bg-neutral-800 text-neutral-400" },
  };
  const m = map[kind] ?? { label: "·", cls: "bg-neutral-800 text-neutral-400" };
  return (
    <span
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[10px] font-bold",
        m.cls,
      )}
    >
      {m.label}
    </span>
  );
}

function HunksView({ file }: { file: FileDiff }) {
  if (file.binary) {
    return (
      <div className="m-3 rounded border border-neutral-800 bg-neutral-900/60 p-4 text-center text-xs text-neutral-500">
        Binary file — no diff preview
      </div>
    );
  }
  return (
    <div className="font-mono text-xs">
      {file.hunks.length === 0 ? (
        <div className="m-3 text-center text-xs text-neutral-600">
          {(file.status.kind === "deleted" && "File deleted.") ||
            (file.status.kind === "added" && "New empty file.") ||
            "No hunks."}
        </div>
      ) : (
        file.hunks.map((h) => (
          <div key={h.id} className="border-t border-neutral-900">
            <div className="bg-neutral-900/60 px-3 py-1 text-[11px] text-neutral-500">
              {h.header.trim()}
            </div>
            {h.lines.map((line, i) => (
              <LineRow key={i} line={line} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

function LineRow({ line }: { line: DiffLine }) {
  const kind = line.kind;
  const cls =
    kind === "add"
      ? "bg-emerald-950/40 text-emerald-200"
      : kind === "del"
        ? "bg-rose-950/40 text-rose-200"
        : "text-neutral-400";
  const prefix = kind === "add" ? "+" : kind === "del" ? "-" : " ";
  return (
    <div className={cn("flex", cls)}>
      <span className="w-4 shrink-0 select-none px-1 text-center text-neutral-600">
        {prefix}
      </span>
      <pre className="flex-1 whitespace-pre-wrap break-all px-2 py-0">
        {line.content}
      </pre>
    </div>
  );
}
