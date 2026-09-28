import { describe, expect, it } from "vitest";
import { isLocalUrl, normalizeBrowserUrl } from "./browser-url";

describe("normalizeBrowserUrl", () => {
  it("treats a bare port as localhost", () => {
    expect(normalizeBrowserUrl("5173")).toBe("http://localhost:5173/");
  });
  it("adds http when the scheme is missing", () => {
    expect(normalizeBrowserUrl(" localhost:3000/app ")).toBe("http://localhost:3000/app");
  });
  it("rewrites 0.0.0.0 to localhost", () => {
    expect(normalizeBrowserUrl("http://0.0.0.0:8000")).toBe("http://localhost:8000/");
  });
  it("rejects empty and non-http input", () => {
    expect(normalizeBrowserUrl("  ")).toBeNull();
    expect(normalizeBrowserUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("isLocalUrl", () => {
  it("matches loopback hosts only", () => {
    expect(isLocalUrl("http://localhost:5173/")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLocalUrl("http://app.localhost:3000")).toBe(true);
    expect(isLocalUrl("https://example.com")).toBe(false);
  });
});
