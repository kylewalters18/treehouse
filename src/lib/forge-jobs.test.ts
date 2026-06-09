import { describe, it, expect } from "vitest";
import { latestJobsPerName } from "./forge-jobs";
import type { ForgeJob } from "@/ipc/types";

function job(p: Partial<ForgeJob>): ForgeJob {
  return { id: 1, name: "test", stage: "test", status: "failed", retried: false, ...p };
}

describe("latestJobsPerName", () => {
  it("keeps only the highest-id run of a retried job", () => {
    // A job failed (id 10), retried and failed again (id 20). GitLab returns
    // both; we want one — the latest.
    const out = latestJobsPerName([
      job({ id: 10, name: "build", stage: "build", status: "failed" }),
      job({ id: 20, name: "build", stage: "build", status: "failed" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(20);
  });

  it("does not rely on the `retried` flag (GitLab leaves it false on both)", () => {
    const out = latestJobsPerName([
      job({ id: 10, name: "lint", stage: "test", status: "failed", retried: false }),
      job({ id: 31, name: "lint", stage: "test", status: "success", retried: false }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(31);
    expect(out[0].status).toBe("success");
  });

  it("keeps distinct jobs even when one is retried", () => {
    const out = latestJobsPerName([
      job({ id: 1, name: "unit", stage: "test" }),
      job({ id: 2, name: "e2e", stage: "test" }),
      job({ id: 9, name: "unit", stage: "test" }), // retry of unit
    ]);
    expect(out.map((j) => j.name).sort()).toEqual(["e2e", "unit"]);
    expect(out.find((j) => j.name === "unit")!.id).toBe(9);
  });

  it("does not merge same-named jobs in different stages", () => {
    const out = latestJobsPerName([
      job({ id: 1, name: "deploy", stage: "staging" }),
      job({ id: 2, name: "deploy", stage: "prod" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("returns an empty array for no jobs", () => {
    expect(latestJobsPerName([])).toEqual([]);
  });
});
