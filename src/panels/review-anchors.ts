import type { editor as MonacoEditor, Selection } from "monaco-editor";
import type { CommentSide } from "@/ipc/types";

// Pure helpers for anchoring review comments in Monaco: what a new comment
// targets, how it's labelled, and how base-side (removed) lines map onto
// the modified editor of an inline diff. Kept free of React / stores so
// they're unit-testable.

/// What a new comment will attach to: a line, an inclusive line range, or
/// the whole file (`line === 0`), on the head or base side of the diff.
export type CommentTarget = {
  line: number;
  endLine: number | null;
  side: CommentSide;
};

/// Human label for a comment target, shown in the composer header.
export function targetLabel(t: CommentTarget): string {
  if (t.line === 0) return "Whole file";
  const range =
    t.endLine !== null && t.endLine !== t.line
      ? `Lines ${t.line}–${t.endLine}`
      : `Line ${t.line}`;
  return t.side === "base" ? `Removed · ${range.toLowerCase()}` : range;
}

/// A head-side range target from a multi-line selection that covers
/// `line`, or null. A selection ending at column 1 (dragging down the line
/// numbers does this) doesn't include that last line.
export function rangeFromSelection(
  sel: Selection | null,
  line: number,
): CommentTarget | null {
  if (!sel || sel.isEmpty()) return null;
  const start = sel.startLineNumber;
  const end =
    sel.endColumn === 1 && sel.endLineNumber > start
      ? sel.endLineNumber - 1
      : sel.endLineNumber;
  if (end <= start || line < start || line > end) return null;
  return { line: start, endLine: end, side: "head" };
}

/// Maps base-version line numbers onto the modified editor of an inline
/// diff, and back from Monaco's deleted-code zones to base lines. Built
/// from `getLineChanges()` (legacy shape: an `*EndLineNumber` of 0 means
/// that side is empty; a pure deletion sits after `modifiedStartLineNumber`).
export function baseLineMapper(changes: MonacoEditor.ILineChange[]) {
  const span = (start: number, end: number) => (end === 0 ? 0 : end - start + 1);
  /// Modified line the deleted-code zone for `c` sits after.
  const zoneAfter = (c: MonacoEditor.ILineChange) =>
    c.modifiedEndLineNumber === 0
      ? c.modifiedStartLineNumber
      : c.modifiedStartLineNumber - 1;
  return {
    /// Modified line after which a comment on base line `line` renders:
    /// under the deleted block when the line was removed or changed, else
    /// after the line's unchanged counterpart.
    afterFor(line: number): number {
      let delta = 0;
      for (const c of changes) {
        const removed = span(c.originalStartLineNumber, c.originalEndLineNumber);
        if (removed > 0 && line >= c.originalStartLineNumber && line <= c.originalEndLineNumber) {
          return zoneAfter(c);
        }
        const lastOriginal = removed > 0 ? c.originalEndLineNumber : c.originalStartLineNumber;
        if (lastOriginal < line) {
          delta += span(c.modifiedStartLineNumber, c.modifiedEndLineNumber) - removed;
        }
      }
      return Math.max(0, line + delta);
    },
    /// Base line for row `offset` of the deleted-code zone after modified
    /// line `after`, or null when no deletion sits there.
    baseLineAt(after: number, offset: number): number | null {
      for (const c of changes) {
        const removed = span(c.originalStartLineNumber, c.originalEndLineNumber);
        if (removed > 0 && zoneAfter(c) === after) {
          return Math.min(c.originalEndLineNumber, c.originalStartLineNumber + Math.max(0, offset));
        }
      }
      return null;
    },
  };
}
