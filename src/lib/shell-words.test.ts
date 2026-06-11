import { describe, it, expect } from "vitest";
import { splitCommand } from "./shell-words";

describe("splitCommand", () => {
  it("splits a bare binary", () => {
    expect(splitCommand("claude")).toEqual(["claude"]);
  });

  it("splits binary and flags on whitespace", () => {
    expect(splitCommand("claude --agent reviewer")).toEqual([
      "claude",
      "--agent",
      "reviewer",
    ]);
  });

  it("handles a subcommand", () => {
    expect(splitCommand("kiro-cli chat")).toEqual(["kiro-cli", "chat"]);
  });

  it("keeps double-quoted args together", () => {
    expect(splitCommand('claude --agent "code reviewer"')).toEqual([
      "claude",
      "--agent",
      "code reviewer",
    ]);
  });

  it("keeps single-quoted args together", () => {
    expect(splitCommand("a 'b c' d")).toEqual(["a", "b c", "d"]);
  });

  it("collapses runs of whitespace and trims", () => {
    expect(splitCommand("  spaced   out \t x ")).toEqual([
      "spaced",
      "out",
      "x",
    ]);
  });

  it("returns [] for empty / whitespace-only input", () => {
    expect(splitCommand("")).toEqual([]);
    expect(splitCommand("   ")).toEqual([]);
  });

  it("preserves an explicit empty-string argument", () => {
    expect(splitCommand("cmd ''")).toEqual(["cmd", ""]);
  });

  it("honors backslash escapes outside quotes", () => {
    expect(splitCommand("a\\ b")).toEqual(["a b"]);
  });

  it("honors backslash escapes inside double quotes", () => {
    expect(splitCommand('say "a\\"b"')).toEqual(["say", 'a"b']);
  });

  it("tolerates an unterminated quote", () => {
    expect(splitCommand('claude "unclosed')).toEqual(["claude", "unclosed"]);
  });
});
