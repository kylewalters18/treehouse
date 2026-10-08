import { describe, expect, it } from "vitest";

import { lineIndents } from "./CodeBlock";

describe("lineIndents", () => {
  it("measures each line's leading whitespace", () => {
    expect(lineIndents("def f():\n    x = 1\n        y\n", "python")).toEqual([0, 4, 8, 0]);
  });

  it("counts tabs to the next 4-column stop", () => {
    expect(lineIndents("\tx\n  \ty\n\t\tz")).toEqual([4, 4, 8]);
  });

  it("measures past a diff's +/- marker", () => {
    expect(lineIndents("-    old\n+  new\n+x", "diff")).toEqual([5, 3, 1]);
  });

  it("gives blank and whitespace-only lines no indent", () => {
    expect(lineIndents("a\n\n    \nb")).toEqual([0, 0, 0, 0]);
  });
});
