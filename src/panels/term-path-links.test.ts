import { describe, expect, it } from "vitest";
import {
  linksForLine,
  parsePathWithLineCol,
  resolveToWorktreeRelative,
} from "./term-path-links";

const FAKE_WORKTREE_ID =
  "01HZE2ESTWORKTREE0000000AAA" as unknown as import("@/ipc/types").WorktreeId;

describe("parsePathWithLineCol", () => {
  it("returns the path verbatim when no line suffix is present", () => {
    expect(parsePathWithLineCol("src/foo.ts")).toEqual({
      path: "src/foo.ts",
      line: null,
      column: null,
    });
  });

  it("parses :line into a 1-based line, defaults column to 1", () => {
    expect(parsePathWithLineCol("src/foo.ts:42")).toEqual({
      path: "src/foo.ts",
      line: 42,
      column: 1,
    });
  });

  it("parses :line:col", () => {
    expect(parsePathWithLineCol("src/foo.ts:42:5")).toEqual({
      path: "src/foo.ts",
      line: 42,
      column: 5,
    });
  });

  it("ignores trailing colons that aren't line numbers", () => {
    expect(parsePathWithLineCol("src/foo.ts:notanumber")).toEqual({
      path: "src/foo.ts:notanumber",
      line: null,
      column: null,
    });
  });
});

describe("resolveToWorktreeRelative", () => {
  const root = "/Users/me/Code/repo";

  it("strips the worktree root from absolute paths inside it", () => {
    expect(resolveToWorktreeRelative(`${root}/src/foo.ts`, root)).toBe(
      "src/foo.ts",
    );
  });

  it("returns null for absolute paths outside the worktree", () => {
    expect(resolveToWorktreeRelative("/etc/passwd", root)).toBeNull();
    expect(resolveToWorktreeRelative("/Users/me/elsewhere/x.ts", root)).toBeNull();
  });

  it("strips a leading ./ from relative paths", () => {
    expect(resolveToWorktreeRelative("./src/foo.ts", root)).toBe("src/foo.ts");
  });

  it("passes plain relative paths through unchanged", () => {
    expect(resolveToWorktreeRelative("src/foo.ts", root)).toBe("src/foo.ts");
  });

  it("handles a worktree root with a trailing slash", () => {
    expect(
      resolveToWorktreeRelative(`${root}/src/foo.ts`, `${root}/`),
    ).toBe("src/foo.ts");
  });

  it("does not match a path whose absolute prefix is a substring of the worktree root", () => {
    // `/Users/me/Code/repo-other/x.ts` vs root `/Users/me/Code/repo` —
    // naive prefix-match would resolve "other/x.ts" but that's wrong.
    expect(
      resolveToWorktreeRelative("/Users/me/Code/repo-other/x.ts", root),
    ).toBeNull();
  });
});

describe("linksForLine", () => {
  it("matches a worktree-relative path with line:col suffix", () => {
    const line = "src/foo.ts:42:5 - error TS2304";
    const links = linksForLine(line, 1, FAKE_WORKTREE_ID);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("src/foo.ts:42:5");
    // 1-based, inclusive cells: starts at column 1, ends at column 15.
    expect(links[0].range.start).toEqual({ x: 1, y: 1 });
    expect(links[0].range.end).toEqual({ x: 15, y: 1 });
  });

  it("matches an absolute path inside parens (Node stack-trace shape)", () => {
    const line = "    at f (/Users/x/foo.js:23:14)";
    const links = linksForLine(line, 7, FAKE_WORKTREE_ID);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("/Users/x/foo.js:23:14");
    expect(links[0].range.start.y).toBe(7);
  });

  it("matches a leading ./ relative path", () => {
    const line = "import x from './src/foo.ts'";
    const links = linksForLine(line, 1, FAKE_WORKTREE_ID);
    expect(links.map((l) => l.text)).toContain("./src/foo.ts");
  });

  it("matches multiple paths on a single line", () => {
    const line = "diff src/a.ts src/b.ts";
    const links = linksForLine(line, 1, FAKE_WORKTREE_ID);
    expect(links.map((l) => l.text)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("matches bare filenames with a code-like extension", () => {
    // Users expect to Cmd+click `bar.py` from agent output even when
    // there's no `./` prefix. Extension starts with a letter so we
    // avoid catching version strings.
    expect(linksForLine("see bar.py", 1, FAKE_WORKTREE_ID).map((l) => l.text))
      .toEqual(["bar.py"]);
    expect(
      linksForLine("see package.json", 1, FAKE_WORKTREE_ID).map((l) => l.text),
    ).toEqual(["package.json"]);
    expect(
      linksForLine("at foo.tsx:42:5", 1, FAKE_WORKTREE_ID).map((l) => l.text),
    ).toEqual(["foo.tsx:42:5"]);
  });

  it("ignores plain numbers with dots (version strings, decimals)", () => {
    // `2.5.1`, `1.0`, `0.42` — the extension would start with a
    // digit; we explicitly require an alpha first character.
    expect(linksForLine("v1.2.3 — 0.42 ms", 1, FAKE_WORKTREE_ID)).toEqual([]);
    expect(linksForLine("running 2.5.1 build", 1, FAKE_WORKTREE_ID)).toEqual(
      [],
    );
  });

  it("emits underline + pointer-cursor decorations on every match", () => {
    const links = linksForLine("see src/foo.ts", 1, FAKE_WORKTREE_ID);
    expect(links[0].decorations).toEqual({
      pointerCursor: true,
      underline: true,
    });
  });
});
