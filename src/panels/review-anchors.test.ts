import { describe, expect, it } from "vitest";
import type { editor as MonacoEditor, Selection } from "monaco-editor";
import { baseLineMapper, rangeFromSelection, targetLabel } from "./review-anchors";

function change(
  originalStartLineNumber: number,
  originalEndLineNumber: number,
  modifiedStartLineNumber: number,
  modifiedEndLineNumber: number,
): MonacoEditor.ILineChange {
  return {
    originalStartLineNumber,
    originalEndLineNumber,
    modifiedStartLineNumber,
    modifiedEndLineNumber,
    charChanges: undefined,
  } as MonacoEditor.ILineChange;
}

function sel(
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number,
): Selection {
  return {
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
    isEmpty: () => startLineNumber === endLineNumber && startColumn === endColumn,
  } as Selection;
}

describe("baseLineMapper", () => {
  // base: 10 lines. Lines 3–4 deleted outright (zone sits after modified
  // line 2); lines 7–8 replaced by modified lines 5–7 (zone after 4).
  const m = baseLineMapper([change(3, 4, 2, 0), change(7, 8, 5, 7)]);

  it("anchors removed lines under their deleted-code zone", () => {
    expect(m.afterFor(3)).toBe(2);
    expect(m.afterFor(4)).toBe(2);
    expect(m.afterFor(8)).toBe(4);
  });

  it("shifts unchanged base lines by the net lines added/removed above", () => {
    expect(m.afterFor(1)).toBe(1);
    expect(m.afterFor(5)).toBe(3); // −2 from the deletion
    expect(m.afterFor(10)).toBe(9); // −2, then +1 from the 2→3 replacement
  });

  it("resolves a hovered row in a deleted zone back to its base line", () => {
    expect(m.baseLineAt(2, 0)).toBe(3);
    expect(m.baseLineAt(2, 1)).toBe(4);
    expect(m.baseLineAt(2, 9)).toBe(4); // clamped to the block
    expect(m.baseLineAt(4, 0)).toBe(7);
    expect(m.baseLineAt(3, 0)).toBeNull(); // no deletion after line 3
  });

  it("ignores pure insertions when looking up deleted zones", () => {
    const ins = baseLineMapper([change(2, 0, 3, 4)]);
    expect(ins.baseLineAt(2, 0)).toBeNull();
    expect(ins.afterFor(5)).toBe(7);
  });
});

describe("rangeFromSelection", () => {
  it("builds a range when the selection covers the clicked line", () => {
    expect(rangeFromSelection(sel(3, 1, 6, 4), 5)).toEqual({
      line: 3,
      endLine: 6,
      side: "head",
    });
  });

  it("drops a trailing line selected only up to column 1", () => {
    expect(rangeFromSelection(sel(3, 1, 7, 1), 4)?.endLine).toBe(6);
  });

  it("returns null for empty, single-line, or non-covering selections", () => {
    expect(rangeFromSelection(sel(3, 2, 3, 2), 3)).toBeNull();
    expect(rangeFromSelection(sel(3, 1, 3, 9), 3)).toBeNull();
    expect(rangeFromSelection(sel(3, 1, 4, 1), 3)).toBeNull();
    expect(rangeFromSelection(sel(3, 1, 6, 4), 9)).toBeNull();
  });
});

describe("targetLabel", () => {
  it("labels lines, ranges, removed lines and whole files", () => {
    expect(targetLabel({ line: 4, endLine: null, side: "head" })).toBe("Line 4");
    expect(targetLabel({ line: 4, endLine: 9, side: "head" })).toBe("Lines 4–9");
    expect(targetLabel({ line: 4, endLine: null, side: "base" })).toBe(
      "Removed · line 4",
    );
    expect(targetLabel({ line: 0, endLine: null, side: "head" })).toBe("Whole file");
  });
});
