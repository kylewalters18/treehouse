/// Pure pieces of the editor's reload-on-disk path, kept free of Monaco
/// and React so they can be unit-tested. EditorPane wires them together:
/// `createCoalescedRunner` serializes the reads a burst of diff_updated
/// events kicks off, `classifyDiskRead` decides what a read means for
/// the buffer, and `computeLineEdits` turns "old buffer → new disk text"
/// into per-hunk edits so Monaco's viewport anchor survives agent writes.

// --- Line diff ---

/// Replace `oldText.slice(start, end)` with `text`. Offsets are into the
/// OLD text; a list of these is non-overlapping and ascending, which is
/// exactly what `model.pushEditOperations` wants.
export type TextEdit = { start: number; end: number; text: string };

/// Past this many differing lines Myers' trace gets expensive; fall back
/// to one edit spanning the (prefix/suffix-trimmed) middle. That's the
/// old single-replace behavior — fine for "agent rewrote the file".
const MAX_EDIT_DISTANCE = 1000;

/// Split into lines that keep their terminator, so joining the pieces
/// round-trips exactly and `"a"` vs `"a\n"` compare as different lines.
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/// Minimal-ish line-level edits turning `oldText` into `newText`: one
/// edit per changed hunk rather than one edit spanning first-change →
/// last-change. The distinction matters in Monaco: an edit whose range
/// covers the viewport's top line collapses the stable-viewport anchor
/// to the edit start, so a single spanning edit for a change at line 10
/// and another at line 500 yanks a reader at line 200 back to line 10.
export function computeLineEdits(oldText: string, newText: string): TextEdit[] {
  if (oldText === newText) return [];
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }

  // Intern lines to ints so the diff loop compares numbers, not strings.
  const ids = new Map<string, number>();
  const intern = (l: string) => {
    let id = ids.get(l);
    if (id === undefined) {
      id = ids.size;
      ids.set(l, id);
    }
    return id;
  };
  const midA = a.slice(pre, a.length - suf).map(intern);
  const midB = b.slice(pre, b.length - suf).map(intern);

  const hunks = myersHunks(midA, midB, MAX_EDIT_DISTANCE) ?? [
    [0, midA.length, 0, midB.length] as Hunk,
  ];

  // Line index → char offset in the old text.
  const offsets = new Array<number>(a.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < a.length; i++) offsets[i + 1] = offsets[i] + a[i].length;

  return hunks.map(([as, ae, bs, be]) => ({
    start: offsets[pre + as],
    end: offsets[pre + ae],
    text: b.slice(pre + bs, pre + be).join(""),
  }));
}

/// [aStart, aEnd, bStart, bEnd), half-open line ranges.
type Hunk = [number, number, number, number];

/// Myers O((N+M)·D) shortest edit script, returned as hunks (maximal runs
/// of non-matching lines between matches). `null` when the edit distance
/// exceeds `maxD`. Each trace snapshot only keeps the diagonals reachable
/// at that depth, so memory is O(D²), not O((N+M)·D).
function myersHunks(a: number[], b: number[], maxD: number): Hunk[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [[0, n, 0, m]];
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] = v[-d-1 .. d+1] as it stood before depth d ran.
  const trace: Int32Array[] = [];
  const limit = Math.min(max, maxD);
  let found = false;
  for (let d = 0; d <= limit && !found; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])
          ? v[off + k + 1]
          : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return null;

  // Backtrack, collecting matched line pairs (in reverse).
  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snap = trace[d];
    const at = (k: number) => snap[k + d + 1];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      matches.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  matches.reverse();

  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  for (const [mx, my] of [...matches, [n, m] as [number, number]]) {
    if (mx > ai || my > bi) hunks.push([ai, mx, bi, my]);
    ai = mx + 1;
    bi = my + 1;
  }
  return hunks;
}

// --- Read classification ---

/// Outcome of one `readFile` for the open path. `text: null` is the
/// binary / oversized case.
export type DiskRead = { ok: true; text: string | null } | { ok: false };

export type DiskVerdict =
  /// Binary / oversized — out of scope for the editor's conflict policy.
  | { kind: "ignore" }
  /// Disk matches what we last loaded / saved (our own ⌘S echo, or a
  /// no-op rewrite). Nothing to do.
  | { kind: "echo" }
  | { kind: "changed"; content: string }
  | { kind: "deleted" }
  /// Looks like a mid-write window: the read failed, or came back empty
  /// where we had content. Agents truncate-then-write (and some tools
  /// unlink-then-create), so a single such read is more often transient
  /// than real. Re-read after a beat and pass `confirmed` = true.
  | { kind: "suspect" };

/// How long to wait before re-reading after a `suspect` verdict. Long
/// enough to outlast a truncate-then-write or unlink-then-create from an
/// agent's file tool.
export const SUSPECT_RECHECK_MS = 200;

export function classifyDiskRead(
  read: DiskRead,
  lastRead: string,
  confirmed: boolean,
): DiskVerdict {
  if (!read.ok) return confirmed ? { kind: "deleted" } : { kind: "suspect" };
  if (read.text === null) return { kind: "ignore" };
  if (read.text === lastRead) return { kind: "echo" };
  if (read.text === "" && !confirmed) return { kind: "suspect" };
  return { kind: "changed", content: read.text };
}

// --- Coalesced runner ---

export type CoalescedRunner = {
  /// Request a run. Starts one if idle; otherwise marks a single
  /// follow-up run, however many triggers land while one is in flight.
  trigger: () => void;
  /// Stop: the in-flight run sees `isStale() === true`, no follow-up.
  dispose: () => void;
};

/// Serialize an async task and coalesce triggers: at most one run in
/// flight plus one pending. The task gets `isStale()`, true once a newer
/// trigger (or dispose) has arrived — check it after every await and
/// bail rather than apply a result the pending run will supersede. This
/// is what keeps out-of-order `readFile` responses from applying stale
/// content on top of newer content during a burst of diff events.
export function createCoalescedRunner(
  task: (isStale: () => boolean) => Promise<void>,
): CoalescedRunner {
  let running = false;
  let pending = false;
  let disposed = false;
  const isStale = () => pending || disposed;
  const loop = async () => {
    running = true;
    try {
      do {
        pending = false;
        try {
          await task(isStale);
        } catch {
          // A failed run shouldn't wedge the runner; the task owns its
          // own error reporting.
        }
      } while (pending && !disposed);
    } finally {
      running = false;
    }
  };
  return {
    trigger() {
      if (disposed) return;
      if (running) {
        pending = true;
        return;
      }
      void loop();
    },
    dispose() {
      disposed = true;
    },
  };
}
