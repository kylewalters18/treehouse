import { describe, expect, it } from "vitest";
import {
  activeToken,
  applyCompletion,
  caretOnEdgeLine,
  formatTokens,
  historyStep,
  mentionedFiles,
  promptHistory,
} from "./acp-prompt";

describe("activeToken", () => {
  it("finds an @file token at the caret anywhere in the prompt", () => {
    const text = "look at @src/li please";
    const caret = "look at @src/li".length;
    expect(activeToken(text, caret)).toEqual({ kind: "file", query: "src/li", start: 8, end: 15 });
    expect(activeToken("@", 1)).toEqual({ kind: "file", query: "", start: 0, end: 1 });
  });

  it("finds /commands only as the first word", () => {
    expect(activeToken("/comp", 5)).toEqual({ kind: "command", query: "comp", start: 0, end: 5 });
    expect(activeToken("  /rev", 6)?.kind).toBe("command");
    expect(activeToken("see /usr/bin", 12)).toBeNull();
    // Past the command's first word, no completion.
    expect(activeToken("/review 12", 10)).toBeNull();
  });

  it("ignores plain words", () => {
    expect(activeToken("hello", 3)).toBeNull();
    expect(activeToken("a@b.com", 7)).toBeNull();
  });
});

describe("applyCompletion", () => {
  it("replaces the token and leaves one space before the rest", () => {
    const text = "look at @src/li please";
    const token = activeToken(text, 15)!;
    expect(applyCompletion(text, token, "src/lib.rs")).toEqual({
      text: "look at @src/lib.rs please",
      caret: "look at @src/lib.rs ".length,
    });
    const cmd = activeToken("/co", 3)!;
    expect(applyCompletion("/co", cmd, "compact")).toEqual({ text: "/compact ", caret: 9 });
  });
});

describe("mentionedFiles", () => {
  const known = new Set(["src/lib.rs", "README.md"]);

  it("collects known @paths in order, once each", () => {
    expect(mentionedFiles("@README.md and @src/lib.rs, then @README.md again", known)).toEqual([
      "README.md",
      "src/lib.rs",
    ]);
  });

  it("skips unknown paths and mid-word @", () => {
    expect(mentionedFiles("mail me@example.com about @nope.rs", known)).toEqual([]);
    expect(mentionedFiles("see @src/lib.rs.", known)).toEqual(["src/lib.rs"]);
  });
});

describe("formatTokens", () => {
  it("abbreviates", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(50_400)).toBe("50k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});

describe("prompt history", () => {
  it("collects sent prompts, collapsing repeats and blanks", () => {
    expect(promptHistory(["a", " a ", "", "b", "a"])).toEqual(["a", "b", "a"]);
  });

  it("steps older from the draft, stops at the oldest, and returns to the draft", () => {
    expect(historyStep(3, null, -1)).toBe(2);
    expect(historyStep(3, 2, -1)).toBe(1);
    expect(historyStep(3, 0, -1)).toBe(0);
    expect(historyStep(3, 1, 1)).toBe(2);
    expect(historyStep(3, 2, 1)).toBeNull();
    expect(historyStep(3, null, 1)).toBeNull();
    expect(historyStep(0, null, -1)).toBeNull();
  });

  it("knows when the caret is on the first or last line", () => {
    expect(caretOnEdgeLine("one\ntwo", 2, "first")).toBe(true);
    expect(caretOnEdgeLine("one\ntwo", 5, "first")).toBe(false);
    expect(caretOnEdgeLine("one\ntwo", 5, "last")).toBe(true);
    expect(caretOnEdgeLine("one\ntwo", 2, "last")).toBe(false);
  });
});
