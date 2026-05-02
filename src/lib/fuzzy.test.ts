import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("returns null when the needle isn't a subsequence", () => {
    expect(fuzzyScore("AgentPane.tsx", "xyz")).toBeNull();
    expect(fuzzyScore("a", "ab")).toBeNull();
  });

  it("returns a zero-score result for an empty needle", () => {
    expect(fuzzyScore("anything", "")).toEqual({ score: 0, matches: [] });
  });

  it("matches camel-case boundaries", () => {
    const r = fuzzyScore("AgentPane.tsx", "ap");
    expect(r).not.toBeNull();
    // 'a' at index 0 (start), 'P' at index 5 (camel boundary).
    expect(r!.matches).toEqual([0, 5]);
  });

  it("ranks word-boundary matches higher than mid-word", () => {
    const a = fuzzyScore("agent_pane.ts", "ap")!;
    const b = fuzzyScore("agentpane.ts", "ap")!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("ranks consecutive matches higher than scattered ones", () => {
    const a = fuzzyScore("foobar.ts", "foo")!;
    const b = fuzzyScore("f-o-o-bar.ts", "foo")!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("ranks basename matches over deep-path matches", () => {
    const top = fuzzyScore("util.ts", "util")!;
    const deep = fuzzyScore("util/x/y/z.ts", "util")!;
    expect(top.score).toBeGreaterThan(deep.score);
  });

  it("is case-insensitive but recognizes camel boundaries on the original", () => {
    const r = fuzzyScore("AgentPane", "AP");
    expect(r).not.toBeNull();
    expect(r!.matches).toEqual([0, 5]);
  });
});

describe("fuzzyFilter", () => {
  const files = [
    "src/panels/AgentPane.tsx",
    "src/panels/AgentInstance.test.tsx",
    "src/panels/MarkdownPreview.tsx",
    "src/lib/agent.ts",
    "package.json",
    "README.md",
  ];

  it("ranks AgentPane top for `agtpn`", () => {
    const r = fuzzyFilter(files, "agtpn", (s) => s, 5);
    expect(r[0].item).toBe("src/panels/AgentPane.tsx");
  });

  it("ranks the basename match over deeper-path matches", () => {
    const r = fuzzyFilter(files, "agent", (s) => s, 5);
    // `src/lib/agent.ts` has the basename `agent.ts` — its filename
    // starts with the query exactly, so it should outrank both
    // `AgentPane.tsx` and `AgentInstance.test.tsx`.
    expect(r[0].item).toBe("src/lib/agent.ts");
  });

  it("ties are broken by shorter haystack", () => {
    const r = fuzzyFilter(["xa", "xab", "xabc"], "x", (s) => s, 5);
    expect(r.map((x) => x.item)).toEqual(["xa", "xab", "xabc"]);
  });

  it("returns the first N items unchanged for an empty query", () => {
    const r = fuzzyFilter(files, "", (s) => s, 3);
    expect(r.map((x) => x.item)).toEqual(files.slice(0, 3));
  });

  it("respects the limit", () => {
    const r = fuzzyFilter(files, "t", (s) => s, 2);
    expect(r.length).toBeLessThanOrEqual(2);
  });

  it("filters out non-matches", () => {
    const r = fuzzyFilter(files, "zzznevermatches", (s) => s, 5);
    expect(r).toEqual([]);
  });
});
