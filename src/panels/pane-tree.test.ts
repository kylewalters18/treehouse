import { describe, it, expect } from "vitest";
import {
  closeLeaf,
  findLeaf,
  firstLeaf,
  leaves,
  makeLeaf,
  splitLeaf,
  type PaneNode,
} from "./pane-tree";

const open = () => makeLeaf({ kind: "open" });

describe("pane-tree", () => {
  it("splits a leaf into a split with the original on side A", () => {
    const a = open();
    const b = open();
    const tree = splitLeaf(a, a.localId, "horizontal", b);
    expect(tree.kind).toBe("split");
    if (tree.kind !== "split") throw new Error();
    expect(tree.direction).toBe("horizontal");
    expect(tree.a).toBe(a);
    expect(tree.b).toBe(b);
  });

  it("splits a leaf nested inside an existing split", () => {
    const a = open();
    const b = open();
    const c = open();
    const t1: PaneNode = { kind: "split", id: "s1", direction: "vertical", a, b };
    const t2 = splitLeaf(t1, b.localId, "horizontal", c);
    expect(leaves(t2).map((l) => l.localId).sort()).toEqual(
      [a.localId, b.localId, c.localId].sort(),
    );
    expect(findLeaf(t2, c.localId)).toBe(c);
  });

  it("closes a leaf and collapses its parent split into the sibling", () => {
    const a = open();
    const b = open();
    const tree: PaneNode = { kind: "split", id: "s1", direction: "horizontal", a, b };
    const after = closeLeaf(tree, b.localId);
    expect(after).toBe(a);
  });

  it("returns null when the only remaining leaf is closed", () => {
    const a = open();
    expect(closeLeaf(a, a.localId)).toBeNull();
  });

  it("collapses two levels of split when both children of a subtree empty out", () => {
    const a = open();
    const b = open();
    const c = open();
    const inner: PaneNode = { kind: "split", id: "s2", direction: "horizontal", a: b, b: c };
    const outer: PaneNode = { kind: "split", id: "s3", direction: "vertical", a, b: inner };
    // Close b → inner collapses to c → tree becomes split(a, c) at outer.
    const after1 = closeLeaf(outer, b.localId);
    expect(after1?.kind).toBe("split");
    if (after1?.kind !== "split") throw new Error();
    expect(after1.a).toBe(a);
    expect(after1.b).toBe(c);
    // Close c → outer.b becomes null → outer collapses to a.
    const after2 = closeLeaf(after1, c.localId);
    expect(after2).toBe(a);
  });

  it("firstLeaf walks left-deep", () => {
    const a = open();
    const b = open();
    const tree: PaneNode = { kind: "split", id: "s1", direction: "horizontal", a, b };
    expect(firstLeaf(tree)).toBe(a);
  });
});
