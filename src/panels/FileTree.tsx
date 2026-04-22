import { useCallback, useEffect, useRef, useState } from "react";
import { listTree } from "@/ipc/client";
import type { FileStatus, TreeEntry, WorktreeId } from "@/ipc/types";
import { cn } from "@/lib/cn";

type Props = {
  worktreeId: WorktreeId;
  /// Worktree-relative paths that have a diff entry, for change badges.
  statusByPath: Map<string, FileStatus>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /// Bump this to force a refresh of all currently-expanded directories.
  refreshToken: number;
};

export function FileTree({
  worktreeId,
  statusByPath,
  selectedPath,
  onSelect,
  refreshToken,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [children, setChildren] = useState<Map<string, TreeEntry[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const loadDir = useCallback(
    async (dir: string) => {
      try {
        const entries = await listTree(worktreeId, dir);
        setChildren((prev) => {
          const next = new Map(prev);
          next.set(dir, entries);
          return next;
        });
      } catch (e: unknown) {
        const msg = e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
        setError(msg);
      }
    },
    [worktreeId],
  );

  // Initial load of root.
  useEffect(() => {
    setExpanded(new Set([""]));
    setChildren(new Map());
    setError(null);
    void loadDir("");
  }, [worktreeId, loadDir]);

  // When fs changes (signaled by parent via refreshToken), re-fetch every
  // already-expanded directory so the tree stays current with the agent's
  // work (new files appear, deleted ones disappear).
  useEffect(() => {
    if (refreshToken === 0) return;
    for (const dir of expandedRef.current) {
      void loadDir(dir);
    }
  }, [refreshToken, loadDir]);

  function toggle(dir: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
        if (!children.has(dir)) void loadDir(dir);
      }
      return next;
    });
  }

  if (error) {
    return (
      <div className="m-2 rounded border border-red-900/60 bg-red-950/40 px-2 py-1 text-[11px] text-red-300">
        {error}
      </div>
    );
  }

  const rootEntries = children.get("") ?? [];
  if (rootEntries.length === 0) {
    return (
      <div className="px-3 py-2 text-[11px] text-neutral-600">Loading…</div>
    );
  }

  return (
    <ul className="py-1">
      {rootEntries.map((e) => (
        <TreeNode
          key={e.path}
          entry={e}
          depth={0}
          expanded={expanded}
          children={children}
          selectedPath={selectedPath}
          statusByPath={statusByPath}
          onToggle={toggle}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  entry,
  depth,
  expanded,
  children,
  selectedPath,
  statusByPath,
  onToggle,
  onSelect,
}: {
  entry: TreeEntry;
  depth: number;
  expanded: Set<string>;
  children: Map<string, TreeEntry[]>;
  selectedPath: string | null;
  statusByPath: Map<string, FileStatus>;
  onToggle: (dir: string) => void;
  onSelect: (path: string) => void;
}) {
  const isExpanded = entry.isDir && expanded.has(entry.path);
  const badge = statusByPath.get(entry.path);
  const isSelected = selectedPath === entry.path;
  const dirContents = children.get(entry.path) ?? [];

  return (
    <li>
      <button
        onClick={() => (entry.isDir ? onToggle(entry.path) : onSelect(entry.path))}
        className={cn(
          "flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-[11px] hover:bg-neutral-900",
          isSelected && "bg-neutral-900 text-neutral-100",
        )}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        title={entry.path}
      >
        <span className="w-3 shrink-0 text-center text-neutral-600">
          {entry.isDir ? (isExpanded ? "▾" : "▸") : ""}
        </span>
        <span
          className={cn(
            "truncate font-mono",
            entry.isDir ? "text-neutral-300" : "text-neutral-400",
            badge && !entry.isDir && "text-neutral-100",
          )}
        >
          {entry.name}
        </span>
        {badge && !entry.isDir && (
          <span
            className={cn(
              "ml-auto shrink-0 rounded px-1 font-mono text-[9px] font-bold",
              statusBadgeColor(badge),
            )}
            title={badge.kind}
          >
            {statusBadgeLetter(badge)}
          </span>
        )}
      </button>
      {isExpanded && dirContents.length > 0 && (
        <ul>
          {dirContents.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              children={children}
              selectedPath={selectedPath}
              statusByPath={statusByPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
      {isExpanded && dirContents.length === 0 && expanded.has(entry.path) && (
        <div
          className="px-2 py-0.5 text-[11px] italic text-neutral-700"
          style={{ paddingLeft: `${24 + depth * 12}px` }}
        >
          empty
        </div>
      )}
    </li>
  );
}

function statusBadgeLetter(s: FileStatus): string {
  switch (s.kind) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "untracked":
      return "?";
    default:
      return "·";
  }
}

function statusBadgeColor(s: FileStatus): string {
  switch (s.kind) {
    case "added":
      return "bg-emerald-900/60 text-emerald-300";
    case "modified":
      return "bg-amber-900/60 text-amber-300";
    case "deleted":
      return "bg-rose-900/60 text-rose-300";
    case "renamed":
      return "bg-blue-900/60 text-blue-300";
    case "untracked":
      return "bg-neutral-800 text-neutral-400";
    default:
      return "bg-neutral-800 text-neutral-400";
  }
}
