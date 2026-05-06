import { describe, expect, it } from "vitest";
import {
  combinedLinksForLine,
  linksForLine,
  parsePathWithLineCol,
  resolveToWorktreeRelative,
  urlLinksForLine,
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

  it("expands `~/` against the provided home dir before the prefix check", () => {
    const home = "/Users/me";
    expect(
      resolveToWorktreeRelative("~/Code/repo/src/foo.ts", root, home),
    ).toBe("src/foo.ts");
    // Tolerate a trailing slash on the home dir without producing `//`.
    expect(
      resolveToWorktreeRelative("~/Code/repo/src/foo.ts", root, `${home}/`),
    ).toBe("src/foo.ts");
  });

  it("returns null for `~/` paths outside the worktree", () => {
    expect(
      resolveToWorktreeRelative("~/.zshrc", root, "/Users/me"),
    ).toBeNull();
  });

  it("without a home dir, `~/` paths fall through and don't resolve", () => {
    // No home dir provided (or lookup failed) → `~/foo` isn't expanded
    // and isn't absolute, so it's treated as a relative path that
    // happens to start with `~/`. Resolves to `~/foo` — the EditorPane
    // will fail to read it, which is the desired graceful-degrade.
    expect(resolveToWorktreeRelative("~/.zshrc", root)).toBe("~/.zshrc");
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

  it("matches paths with `+` in directory or file names (e.g. C++)", () => {
    expect(
      linksForLine(
        "/Users/me/Code/C++/main.cpp:10:3 - error",
        1,
        FAKE_WORKTREE_ID,
      ).map((l) => l.text),
    ).toEqual(["/Users/me/Code/C++/main.cpp:10:3"]);
    expect(
      linksForLine("see src/c++/foo.cpp", 1, FAKE_WORKTREE_ID).map(
        (l) => l.text,
      ),
    ).toEqual(["src/c++/foo.cpp"]);
  });

  it("matches paths with `@` (scoped npm packages)", () => {
    expect(
      linksForLine(
        "node_modules/@types/node/index.d.ts",
        1,
        FAKE_WORKTREE_ID,
      ).map((l) => l.text),
    ).toEqual(["node_modules/@types/node/index.d.ts"]);
  });

  it("matches paths with non-ASCII letters", () => {
    expect(
      linksForLine("/Users/me/Café/foo.ts", 1, FAKE_WORKTREE_ID).map(
        (l) => l.text,
      ),
    ).toEqual(["/Users/me/Café/foo.ts"]);
    expect(
      linksForLine("see src/файлы/x.rs", 1, FAKE_WORKTREE_ID).map(
        (l) => l.text,
      ),
    ).toEqual(["src/файлы/x.rs"]);
  });

  it("matches `~/`-prefixed home paths", () => {
    expect(
      linksForLine("see ~/Code/repo/foo.ts:42", 1, FAKE_WORKTREE_ID).map(
        (l) => l.text,
      ),
    ).toEqual(["~/Code/repo/foo.ts:42"]);
    // Single segment after ~/ (dotfiles) — common in shell prompts.
    expect(
      linksForLine("edit ~/.zshrc", 1, FAKE_WORKTREE_ID).map((l) => l.text),
    ).toEqual(["~/.zshrc"]);
  });
});

describe("urlLinksForLine", () => {
  it("matches https and http URLs", () => {
    expect(
      urlLinksForLine("see https://example.com/foo", 1).map((l) => l.text),
    ).toEqual(["https://example.com/foo"]);
    expect(
      urlLinksForLine("plain http://localhost:3000", 1).map((l) => l.text),
    ).toEqual(["http://localhost:3000"]);
  });

  it("strips trailing punctuation from URLs in prose", () => {
    // Real terminal output often wraps URLs in punctuation: "see
    // https://x.com/foo." or "(https://x.com/foo)". The matcher
    // should drop trailing `.,;:!?)>"'` so the link text is clickable.
    expect(
      urlLinksForLine("docs at https://example.com/foo.", 1).map((l) => l.text),
    ).toEqual(["https://example.com/foo"]);
    expect(
      urlLinksForLine("see (https://example.com/foo)", 1).map((l) => l.text),
    ).toEqual(["https://example.com/foo"]);
  });

  it("matches multiple URLs on one line", () => {
    const text =
      "compare https://a.example/x with https://b.example/y";
    expect(urlLinksForLine(text, 1).map((l) => l.text)).toEqual([
      "https://a.example/x",
      "https://b.example/y",
    ]);
  });

  it("does not match non-http schemes", () => {
    // file://, ftp://, etc — different open semantics and easier to
    // get wrong; keep the matcher tight and add others on demand.
    expect(urlLinksForLine("file:///etc/hosts", 1)).toEqual([]);
    expect(urlLinksForLine("ftp://example.com", 1)).toEqual([]);
  });

  it("emits underline + pointer-cursor decorations", () => {
    const links = urlLinksForLine("at https://example.com", 1);
    expect(links[0].decorations).toEqual({
      pointerCursor: true,
      underline: true,
    });
  });

  it("matches URLs that contain `+` in the path or query", () => {
    expect(
      urlLinksForLine("see https://google.com/search?q=C++", 1).map(
        (l) => l.text,
      ),
    ).toEqual(["https://google.com/search?q=C++"]);
  });
});

describe("combinedLinksForLine", () => {
  it("URL ranges win over overlapping path matches", () => {
    // The path matcher's bare-filename branch falsely matches
    // `example.com/foo` from inside `https://example.com/foo`. The
    // combined result must drop that path match — clicking on the
    // URL should hit the URL link, not a phantom file.
    const text = "see https://example.com/foo";
    const links = combinedLinksForLine(text, 1, FAKE_WORKTREE_ID);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("https://example.com/foo");
  });

  it("paths on a line that also has a URL are still emitted", () => {
    // Real terminal output: an error message that mentions a doc URL
    // alongside the offending file. Both should be clickable.
    const text = "src/foo.ts:42 — see https://docs.example/x";
    const texts = combinedLinksForLine(text, 1, FAKE_WORKTREE_ID).map(
      (l) => l.text,
    );
    expect(texts).toContain("https://docs.example/x");
    expect(texts).toContain("src/foo.ts:42");
  });

  it("returns empty for a line with no matches", () => {
    expect(combinedLinksForLine("plain text only", 1, FAKE_WORKTREE_ID)).toEqual(
      [],
    );
  });
});
