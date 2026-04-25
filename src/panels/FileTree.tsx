import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
} from "lucide-react";
import { listTree } from "@/ipc/client";
import type { FileStatus, TreeEntry, WorktreeId } from "@/ipc/types";
import { cn } from "@/lib/cn";
import {
  iconForFile,
  statusFilenameColor,
  type FileIconComponent,
} from "./file-icons";

type Props = {
  worktreeId: WorktreeId;
  /// Worktree-relative paths that have a diff entry, for change tinting.
  statusByPath: Map<string, FileStatus>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /// Bump this to force a refresh of all currently-expanded directories.
  refreshToken: number;
  /// When true, entries covered by `.gitignore` / the built-in ignore list
  /// are included and rendered dimmed.
  showIgnored: boolean;
};

export function FileTree({
  worktreeId,
  statusByPath,
  selectedPath,
  onSelect,
  refreshToken,
  showIgnored,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [children, setChildren] = useState<Map<string, TreeEntry[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const loadDir = useCallback(
    async (dir: string) => {
      try {
        const entries = await listTree(worktreeId, dir, showIgnored);
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
    [worktreeId, showIgnored],
  );

  // Initial load of root.
  useEffect(() => {
    setExpanded(new Set([""]));
    setChildren(new Map());
    setError(null);
    void loadDir("");
  }, [worktreeId, loadDir]);

  // When fs changes (signaled by parent via refreshToken) OR the
  // show-ignored toggle flips, re-fetch every already-expanded directory
  // so the tree stays current.
  useEffect(() => {
    if (refreshToken === 0) return;
    for (const dir of expandedRef.current) {
      void loadDir(dir);
    }
  }, [refreshToken, loadDir]);
  useEffect(() => {
    for (const dir of expandedRef.current) {
      void loadDir(dir);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showIgnored]);

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
  const status = statusByPath.get(entry.path);
  const isSelected = selectedPath === entry.path;
  const dirContents = children.get(entry.path) ?? [];

  const fileIcon = entry.isDir ? null : iconForFile(entry.name);
  const Icon: FileIconComponent = entry.isDir
    ? isExpanded
      ? FolderOpen
      : Folder
    : fileIcon!.Icon;
  const iconColor = entry.isDir ? "#7dd3fc" : fileIcon!.color;
  const Chevron = entry.isDir ? (isExpanded ? ChevronDown : ChevronRight) : null;

  const nameClass =
    entry.ignored
      ? "italic text-neutral-600"
      : status && !entry.isDir
        ? statusFilenameColor(status.kind)
        : entry.isDir
          ? "text-neutral-200"
          : "text-neutral-400";

  return (
    <li>
      <button
        onClick={() => (entry.isDir ? onToggle(entry.path) : onSelect(entry.path))}
        className={cn(
          "relative flex w-full items-center gap-1 py-0.5 pr-2 text-left text-[11px] transition-colors",
          isSelected
            ? "bg-[#3994BC26] text-neutral-100"
            : "hover:bg-white/[0.04]",
        )}
        style={{ paddingLeft: `${4 + depth * 12}px` }}
        title={entry.ignored ? `${entry.path} (ignored)` : entry.path}
      >
        {/* Indent guides — one faint vertical line per ancestor depth,
            centered in each indent step. Stacked rows visually connect
            because adjacent buttons have no vertical gap. */}
        {Array.from({ length: depth }).map((_, i) => (
          <span
            key={i}
            aria-hidden
            className="pointer-events-none absolute bottom-0 top-0 w-px bg-neutral-800"
            style={{ left: `${4 + i * 12 + 5}px` }}
          />
        ))}
        <span className="flex w-3 shrink-0 items-center justify-center text-neutral-500">
          {Chevron ? <Chevron size={11} strokeWidth={2.5} /> : null}
        </span>
        <Icon
          size={13}
          color={iconColor}
          className={cn("shrink-0", entry.ignored && "opacity-50")}
        />
        <span className={cn("truncate font-mono", nameClass)}>
          {entry.name}
        </span>
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
      {isExpanded && dirContents.length === 0 && (
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

