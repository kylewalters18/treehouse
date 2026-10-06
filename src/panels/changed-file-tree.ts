import type { FileDiff } from "@/ipc/types";

export type ChangedTreeNode =
  | {
      kind: "dir";
      /// Full repo-relative path of the deepest folder in this row; used as
      /// the collapse key.
      path: string;
      /// Display label. Chains of single-child folders are compacted into
      /// one row (`src/components/ui`), like VS Code's compact folders.
      name: string;
      children: ChangedTreeNode[];
    }
  | { kind: "file"; path: string; name: string; file: FileDiff };

type MutableDir = {
  dirs: Map<string, MutableDir>;
  files: FileDiff[];
};

/// Build a folder tree from a flat list of changed files. Folders sort
/// before files, each alphabetically.
export function buildChangedTree(files: FileDiff[]): ChangedTreeNode[] {
  const root: MutableDir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let dir = root;
    for (const seg of parts.slice(0, -1)) {
      let next = dir.dirs.get(seg);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        dir.dirs.set(seg, next);
      }
      dir = next;
    }
    dir.files.push(f);
  }
  return toNodes(root, "");
}

function toNodes(dir: MutableDir, prefix: string): ChangedTreeNode[] {
  const out: ChangedTreeNode[] = [];
  const dirNames = [...dir.dirs.keys()].sort(compare);
  for (const name of dirNames) {
    let child = dir.dirs.get(name)!;
    let label = name;
    let path = prefix + name;
    // Compact: fold a folder whose only content is a single subfolder.
    while (child.files.length === 0 && child.dirs.size === 1) {
      const [subName, sub] = [...child.dirs.entries()][0];
      label += "/" + subName;
      path += "/" + subName;
      child = sub;
    }
    out.push({
      kind: "dir",
      path,
      name: label,
      children: toNodes(child, path + "/"),
    });
  }
  const sortedFiles = [...dir.files].sort((a, b) => compare(a.path, b.path));
  for (const f of sortedFiles) {
    out.push({
      kind: "file",
      path: f.path,
      name: f.path.slice(prefix.length),
      file: f,
    });
  }
  return out;
}

function compare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}
