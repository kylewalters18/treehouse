import { describe, it, expect } from "vitest";
import { toForgePosts } from "./review-post";
import type { Comment } from "@/ipc/types";

function comment(partial: Partial<Comment>): Comment {
  return {
    id: "c1",
    workspaceRoot: "/repo",
    branch: "b",
    filePath: "src/a.ts",
    line: 4,
    endLine: null,
    side: "head",
    text: "rename this",
    createdAt: 0,
    sentAt: null,
    resolvedAt: null,
    ...partial,
  };
}

describe("toForgePosts", () => {
  it("posts a single line inline on its line", () => {
    expect(toForgePosts([comment({})])).toEqual({
      inline: [{ filePath: "src/a.ts", line: 4, removed: false, body: "rename this" }],
      general: [],
    });
  });

  it("anchors a range on its last line and spells it out", () => {
    const { inline } = toForgePosts([comment({ line: 4, endLine: 9 })]);
    expect(inline[0].line).toBe(9);
    expect(inline[0].body).toBe("Lines 4–9:\n\nrename this");
  });

  it("marks removed-line comments and sends whole-file ones as general", () => {
    const { inline, general } = toForgePosts([
      comment({ side: "base" }),
      comment({ id: "c2", line: 0, text: "split this file" }),
    ]);
    expect(inline).toHaveLength(1);
    expect(inline[0].removed).toBe(true);
    expect(general).toEqual(["**src/a.ts**\n\nsplit this file"]);
  });
});
