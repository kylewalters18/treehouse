import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { basename, shortHome, formatWhen } from "./Home";

describe("basename", () => {
  it("returns the last segment", () => {
    expect(basename("/a/b/c")).toBe("c");
  });
  it("strips trailing slashes", () => {
    expect(basename("/a/b/c/")).toBe("c");
    expect(basename("/a/b/c////")).toBe("c");
  });
  it("handles root-only and single-segment input", () => {
    expect(basename("")).toBe("");
    expect(basename("solo")).toBe("solo");
  });
});

describe("shortHome", () => {
  it("replaces /Users/<name> with ~", () => {
    expect(shortHome("/Users/kyle/Code/foo")).toBe("~/Code/foo");
  });
  it("leaves non-home paths alone", () => {
    expect(shortHome("/var/tmp/x")).toBe("/var/tmp/x");
  });
});

describe("formatWhen", () => {
  const NOW = new Date("2026-04-20T12:00:00Z").getTime();

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("says 'just now' within a minute", () => {
    expect(formatWhen(NOW - 10_000)).toBe("just now");
  });
  it("reports minutes", () => {
    expect(formatWhen(NOW - 5 * 60_000)).toBe("5m");
  });
  it("reports hours", () => {
    expect(formatWhen(NOW - 3 * 60 * 60_000)).toBe("3h");
  });
  it("reports days", () => {
    expect(formatWhen(NOW - 4 * 24 * 60 * 60_000)).toBe("4d");
  });
  it("reports months", () => {
    expect(formatWhen(NOW - 90 * 24 * 60 * 60_000)).toBe("3mo");
  });
});
