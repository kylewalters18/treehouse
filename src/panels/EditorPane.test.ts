import { describe, it, expect } from "vitest";
import { inferLanguage } from "./EditorPane";

describe("inferLanguage", () => {
  it("resolves common extensions", () => {
    expect(inferLanguage("src/foo.ts")).toBe("typescript");
    expect(inferLanguage("a/b/c.tsx")).toBe("typescript");
    expect(inferLanguage("lib.py")).toBe("python");
    expect(inferLanguage("main.rs")).toBe("rust");
    expect(inferLanguage("server.go")).toBe("go");
    expect(inferLanguage("README.md")).toBe("markdown");
  });

  it("handles `.d.ts` as TypeScript specifically", () => {
    expect(inferLanguage("types/foo.d.ts")).toBe("typescript");
  });

  it("maps shell dialects", () => {
    expect(inferLanguage("run.sh")).toBe("shell");
    expect(inferLanguage("setup.zsh")).toBe("shell");
    expect(inferLanguage("boot.bash")).toBe("shell");
  });

  it("falls back to plaintext for unknown or missing extensions", () => {
    expect(inferLanguage("Makefile")).toBe("plaintext");
    expect(inferLanguage("data.xyzunknown")).toBe("plaintext");
  });
});
