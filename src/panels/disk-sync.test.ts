import { describe, it, expect } from "vitest";
import {
  classifyDiskRead,
  computeLineEdits,
  createCoalescedRunner,
  type TextEdit,
} from "./disk-sync";

function apply(oldText: string, edits: TextEdit[]): string {
  let out = "";
  let at = 0;
  for (const e of edits) {
    expect(e.start).toBeGreaterThanOrEqual(at);
    out += oldText.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + oldText.slice(at);
}

const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`) =>
  Array.from({ length: n }, (_, i) => f(i) + "\n").join("");

describe("computeLineEdits", () => {
  it("is empty for identical text", () => {
    expect(computeLineEdits("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("emits one edit per hunk, not one spanning edit", () => {
    const old = lines(600);
    const next = old
      .replace("line 10\n", "line ten\n")
      .replace("line 500\n", "line 500\nextra\n");
    const edits = computeLineEdits(old, next);
    expect(edits).toHaveLength(2);
    expect(apply(old, edits)).toBe(next);
    // Nothing near line 200 is touched, so Monaco's viewport anchor
    // there survives.
    const line200 = old.indexOf("line 200\n");
    for (const e of edits) {
      expect(line200 < e.start || line200 >= e.end).toBe(true);
    }
  });

  it("round-trips inserts, deletes, and trailing-newline changes", () => {
    const cases: Array<[string, string]> = [
      ["", "a\nb\n"],
      ["a\nb\n", ""],
      ["a\nb\nc\n", "a\nc\n"],
      ["a\nc\n", "a\nb\nc\n"],
      ["a\nb", "a\nb\n"],
      ["x\ny\nz\n", "z\ny\nx\n"],
      ["a\r\nb\r\n", "a\r\nB\r\n"],
      [lines(50), lines(50, (i) => (i % 7 === 0 ? `changed ${i}` : `line ${i}`))],
    ];
    for (const [a, b] of cases) {
      expect(apply(a, computeLineEdits(a, b))).toBe(b);
    }
  });

  it("round-trips randomized edits", () => {
    // Deterministic LCG so a failure reproduces.
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = () => ["a\n", "b\n", "c\n", "d\n", "e"][rand(5)];
    for (let t = 0; t < 300; t++) {
      const a = Array.from({ length: rand(30) }, pick).join("");
      const b = Array.from({ length: rand(30) }, pick).join("");
      expect(apply(a, computeLineEdits(a, b))).toBe(b);
    }
  });

  it("falls back to a single edit when the files share nothing", () => {
    const old = lines(1500, (i) => `old ${i}`);
    const next = lines(1500, (i) => `new ${i}`);
    const edits = computeLineEdits(old, next);
    expect(edits).toHaveLength(1);
    expect(apply(old, edits)).toBe(next);
  });
});

describe("classifyDiskRead", () => {
  it("ignores binary / oversized reads", () => {
    expect(classifyDiskRead({ ok: true, text: null }, "x", false)).toEqual({
      kind: "ignore",
    });
  });

  it("treats disk == lastRead as an echo", () => {
    expect(classifyDiskRead({ ok: true, text: "x" }, "x", false).kind).toBe("echo");
    expect(classifyDiskRead({ ok: true, text: "" }, "", false).kind).toBe("echo");
  });

  it("reports real changes", () => {
    expect(classifyDiskRead({ ok: true, text: "y" }, "x", false)).toEqual({
      kind: "changed",
      content: "y",
    });
  });

  it("holds a failed or emptied read as suspect until confirmed", () => {
    expect(classifyDiskRead({ ok: false }, "x", false).kind).toBe("suspect");
    expect(classifyDiskRead({ ok: false }, "x", true).kind).toBe("deleted");
    expect(classifyDiskRead({ ok: true, text: "" }, "x", false).kind).toBe(
      "suspect",
    );
    expect(classifyDiskRead({ ok: true, text: "" }, "x", true)).toEqual({
      kind: "changed",
      content: "",
    });
  });
});

describe("createCoalescedRunner", () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("serializes runs and coalesces a burst into one follow-up", async () => {
    const gates: Array<ReturnType<typeof deferred>> = [];
    const staleSeen: boolean[] = [];
    const runner = createCoalescedRunner(async (isStale) => {
      const g = deferred();
      gates.push(g);
      await g.promise;
      staleSeen.push(isStale());
    });

    runner.trigger();
    runner.trigger();
    runner.trigger();
    runner.trigger();
    await flush();
    expect(gates).toHaveLength(1); // only one in flight

    gates[0].resolve();
    await flush();
    expect(staleSeen).toEqual([true]); // superseded by the pending run
    expect(gates).toHaveLength(2); // exactly one follow-up

    gates[1].resolve();
    await flush();
    expect(staleSeen).toEqual([true, false]); // latest run applies
    expect(gates).toHaveLength(2);
  });

  it("marks the in-flight run stale on dispose and schedules nothing", async () => {
    const gate = deferred();
    let stale: boolean | null = null;
    let runs = 0;
    const runner = createCoalescedRunner(async (isStale) => {
      runs++;
      await gate.promise;
      stale = isStale();
    });
    runner.trigger();
    runner.dispose();
    runner.trigger();
    gate.resolve();
    await flush();
    expect(stale).toBe(true);
    expect(runs).toBe(1);
  });

  it("keeps running after a task throws", async () => {
    let runs = 0;
    const runner = createCoalescedRunner(async () => {
      runs++;
      throw new Error("boom");
    });
    runner.trigger();
    await flush();
    runner.trigger();
    await flush();
    expect(runs).toBe(2);
  });
});
