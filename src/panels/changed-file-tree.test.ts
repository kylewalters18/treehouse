import { describe, expect, it } from "vitest";
import type { FileDiff } from "@/ipc/types";
import { buildChangedTree, type ChangedTreeNode } from "./changed-file-tree";

function file(path: string): FileDiff {
  return {
    path,
    status: { kind: "modified" },
    hunks: [],
    binary: false,
    insertions: 0,
    deletions: 0,
  } as unknown as FileDiff;
}

/// Render the tree as indented `name` lines (dirs suffixed with `/`).
function outline(nodes: ChangedTreeNode[], depth = 0): string[] {
  return nodes.flatMap((n) => {
    const line = "  ".repeat(depth) + n.name + (n.kind === "dir" ? "/" : "");
    return n.kind === "dir" ? [line, ...outline(n.children, depth + 1)] : [line];
  });
}

describe("buildChangedTree", () => {
  it("compacts single-child folder chains", () => {
    const tree = buildChangedTree([file("src/components/ui/Button.tsx")]);
    expect(outline(tree)).toEqual(["src/components/ui/", "  Button.tsx"]);
    expect(tree[0]).toMatchObject({ kind: "dir", path: "src/components/ui" });
  });

  it("splits at the first branching folder", () => {
    const tree = buildChangedTree([
      file("src/panels/DiffPane.tsx"),
      file("src/panels/HistoryPanel.tsx"),
      file("src/stores/ui.ts"),
      file("README.md"),
    ]);
    expect(outline(tree)).toEqual([
      "src/",
      "  panels/",
      "    DiffPane.tsx",
      "    HistoryPanel.tsx",
      "  stores/",
      "    ui.ts",
      "README.md",
    ]);
  });

  it("does not compact a folder that also holds files", () => {
    const tree = buildChangedTree([file("a/x.ts"), file("a/b/y.ts")]);
    expect(outline(tree)).toEqual(["a/", "  b/", "    y.ts", "  x.ts"]);
  });

  it("keeps full repo paths on file nodes", () => {
    const tree = buildChangedTree([file("a/b/c.ts"), file("a/d.ts")]);
    const dir = tree[0] as Extract<ChangedTreeNode, { kind: "dir" }>;
    expect(dir.children.map((c) => c.path)).toEqual(["a/b", "a/d.ts"]);
  });
});
