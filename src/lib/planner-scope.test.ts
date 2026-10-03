import { describe, it, expect } from "vitest";
import { resolvePlannerScope } from "./planner-scope";

describe("resolvePlannerScope", () => {
  const open = ["a", "b"];

  it("follows the current repo, global with none", () => {
    expect(resolvePlannerScope("a", null, open)).toBe("a");
    expect(resolvePlannerScope(null, null, [])).toBeNull();
  });

  it("keeps a hand pick while staying in the same repo", () => {
    expect(resolvePlannerScope("a", { scope: null, forRepo: "a" }, open)).toBeNull();
    expect(resolvePlannerScope("a", { scope: "b", forRepo: "a" }, open)).toBe("b");
  });

  it("drops the pick after moving to another repo", () => {
    expect(resolvePlannerScope("b", { scope: null, forRepo: "a" }, open)).toBe("b");
  });

  it("ignores a pick of a repo that has been closed", () => {
    expect(resolvePlannerScope("a", { scope: "c", forRepo: "a" }, open)).toBe("a");
  });
});
