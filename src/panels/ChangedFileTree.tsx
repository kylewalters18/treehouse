import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import type { FileDiff } from "@/ipc/types";
import { cn } from "@/lib/cn";
import { buildChangedTree, type ChangedTreeNode } from "./changed-file-tree";
import { explorerRow, iconForFile, statusFilenameColor } from "./file-icons";

/// Changed files grouped by folder, with single-child folder chains
/// compacted into one row (VS Code SCM "tree" view). Folders start
/// expanded; collapse state is local to the list.
export function ChangedFileTree({
  files,
  isSelected,
  onSelect,
  indent = 8,
  className,
}: {
  files: FileDiff[];
  isSelected: (path: string) => boolean;
  onSelect: (path: string) => void;
  /// Left padding of depth-0 rows, so the tree can line up with its header.
  indent?: number;
  className?: string;
}) {
  const tree = useMemo(() => buildChangedTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <ul className={className}>
      {tree.map((node) => (
        <Node
          key={node.path}
          node={node}
          depth={0}
          indent={indent}
          collapsed={collapsed}
          onToggle={toggle}
          isSelected={isSelected}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function Node({
  node,
  depth,
  indent,
  collapsed,
  onToggle,
  isSelected,
  onSelect,
}: {
  node: ChangedTreeNode;
  depth: number;
  indent: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  isSelected: (path: string) => boolean;
  onSelect: (path: string) => void;
}) {
  const isDir = node.kind === "dir";
  const open = isDir && !collapsed.has(node.path);
  const selected = !isDir && isSelected(node.path);

  let icon: React.ReactNode;
  if (isDir) {
    const FolderIcon = open ? FolderOpen : Folder;
    icon = (
      <FolderIcon
        size={13}
        color={open ? "#9AA1AA" : "#7D858F"}
        className="shrink-0"
      />
    );
  } else {
    const { Icon, color } = iconForFile(node.name);
    icon = <Icon size={13} color={color} className="shrink-0" />;
  }
  const Chevron = isDir ? (open ? ChevronDown : ChevronRight) : null;

  return (
    <li>
      <button
        onClick={() => (isDir ? onToggle(node.path) : onSelect(node.path))}
        className={cn(
          "group relative flex h-[22px] w-full items-center gap-1.5 pr-2 text-left text-[12px] transition-colors",
          explorerRow(selected),
        )}
        style={{ paddingLeft: `${indent + depth * 12}px` }}
        title={node.path}
      >
        {/* Indent guides, matching the Files tree. */}
        {Array.from({ length: depth }).map((_, i) => (
          <span
            key={i}
            aria-hidden
            className="pointer-events-none absolute bottom-0 top-0 w-px bg-neutral-800"
            style={{ left: `${indent + i * 12 + 6}px` }}
          />
        ))}
        <span className="flex w-3 shrink-0 items-center justify-center text-neutral-600 group-hover:text-neutral-400">
          {Chevron ? <Chevron size={12} strokeWidth={2} /> : null}
        </span>
        {icon}
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[11px]",
            isDir ? "text-neutral-300" : statusFilenameColor(node.file.status.kind),
          )}
        >
          {node.name}
        </span>
        {!isDir && (
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
            <span className="text-emerald-400">+{node.file.insertions}</span>{" "}
            <span className="text-rose-400">-{node.file.deletions}</span>
          </span>
        )}
      </button>
      {open && (
        <ul>
          {node.children.map((child) => (
            <Node
              key={child.path}
              node={child}
              depth={depth + 1}
              indent={indent}
              collapsed={collapsed}
              onToggle={onToggle}
              isSelected={isSelected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
