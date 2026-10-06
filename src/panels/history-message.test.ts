import { describe, expect, it } from "vitest";
import { splitMessage } from "./HistoryPanel";

describe("splitMessage", () => {
  it("returns nothing for a summary-only message", () => {
    expect(splitMessage("fix: thing")).toEqual({ body: "", trailers: [] });
  });

  it("separates body from a trailing trailer block", () => {
    const msg =
      "feat: x\n\nWhy it matters.\n\nMore detail.\n\nCo-Authored-By: A <a@b.c>\nSigned-off-by: B";
    expect(splitMessage(msg)).toEqual({
      body: "Why it matters.\n\nMore detail.",
      trailers: [
        ["Co-Authored-By", "A <a@b.c>"],
        ["Signed-off-by", "B"],
      ],
    });
  });

  it("keeps a last paragraph that isn't all trailers in the body", () => {
    const msg = "feat: x\n\nNote: this is prose\nand continues here.";
    expect(splitMessage(msg)).toEqual({
      body: "Note: this is prose\nand continues here.",
      trailers: [],
    });
  });
});
