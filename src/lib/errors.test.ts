import { describe, it, expect } from "vitest";
import { asMessage } from "./errors";

describe("asMessage", () => {
  it("extracts .message from Tauri-style error objects", () => {
    expect(asMessage({ kind: "GitError", message: "boom" })).toBe("boom");
  });

  it("falls back to Error.message for Error instances", () => {
    expect(asMessage(new Error("bad"))).toBe("bad");
  });

  it("returns plain strings as-is", () => {
    expect(asMessage("plain")).toBe("plain");
  });

  it("JSON-stringifies unknown structures", () => {
    expect(asMessage({ foo: 1 })).toBe('{"foo":1}');
  });

  it("does not render '[object Object]' for anything reasonable", () => {
    // The bug we originally shipped — guard against regression.
    expect(asMessage({ kind: "X", message: "real" })).not.toBe("[object Object]");
    expect(asMessage({ foo: "x" })).not.toBe("[object Object]");
  });
});
