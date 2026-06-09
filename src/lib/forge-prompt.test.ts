import { describe, it, expect } from "vitest";
import { formatNoteForAgent, formatThreadForAgent } from "./forge-prompt";
import type { ForgeNote, ForgeThread } from "@/ipc/types";

function note(partial: Partial<ForgeNote>): ForgeNote {
  return {
    id: 1,
    author: "alice",
    body: "needs null handling",
    position: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function inlinePos(newPath: string, newLine: number) {
  return { newPath, newLine, oldPath: null, oldLine: null };
}

function thread(partial: Partial<ForgeThread>): ForgeThread {
  return {
    id: "d1",
    notes: [note({})],
    resolvable: true,
    resolved: false,
    ...partial,
  };
}

describe("formatNoteForAgent", () => {
  it("includes the inline anchor when the note is diff-anchored", () => {
    const out = formatNoteForAgent(
      note({ position: inlinePos("src/foo.ts", 42), body: "  trim me  " }),
    );
    expect(out).toContain("MR review comment on src/foo.ts:42:");
    expect(out).toContain("@alice: trim me");
    expect(out).toContain("Please address this comment.");
  });

  it("omits the anchor for a general (non-anchored) note", () => {
    const out = formatNoteForAgent(note({ position: null }));
    expect(out).toContain("MR review comment:");
    expect(out).not.toContain(" on ");
  });
});

describe("formatThreadForAgent", () => {
  it("anchors on the first inline note and joins every note in order", () => {
    const out = formatThreadForAgent(
      thread({
        notes: [
          note({ id: 1, author: "alice", position: inlinePos("a.ts", 7) }),
          note({ id: 2, author: "bob", body: "and rename the var" }),
        ],
      }),
    );
    expect(out).toContain("MR review thread on a.ts:7:");
    expect(out.indexOf("@alice:")).toBeLessThan(out.indexOf("@bob:"));
    expect(out).toContain("@bob: and rename the var");
    expect(out).toContain("Please address this review thread.");
  });

  it("falls back to a non-anchored header when no note has a position", () => {
    const out = formatThreadForAgent(
      thread({ notes: [note({ position: null })] }),
    );
    expect(out).toContain("MR review thread:");
    expect(out).not.toContain(" on ");
  });
});
