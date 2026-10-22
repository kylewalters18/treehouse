import { describe, expect, it } from "vitest";
import { findRanges } from "./AcpFindBar";

describe("findRanges", () => {
  it("finds every case-insensitive hit, in document order", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Cache the <b>cache</b></p><pre>no CACHE-cache</pre>";
    const hits = findRanges(root, "cache").map((r) => [r.startContainer.textContent, r.startOffset]);
    expect(hits).toEqual([
      ["Cache the ", 0],
      ["cache", 0],
      ["no CACHE-cache", 3],
      ["no CACHE-cache", 9],
    ]);
  });

  it("finds nothing for an empty query", () => {
    const root = document.createElement("div");
    root.textContent = "anything";
    expect(findRanges(root, "")).toEqual([]);
  });
});
