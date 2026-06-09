import { describe, it, expect } from "vitest";
import { ciStatusVisual, stageStatus } from "./ci-status";
import type { ForgeJob } from "@/ipc/types";

function job(status: string): ForgeJob {
  return { id: 1, name: status, stage: "test", status, retried: false };
}

describe("stageStatus", () => {
  it("is failed when any job failed, regardless of others", () => {
    expect(stageStatus([job("success"), job("failed"), job("running")])).toBe("failed");
  });

  it("is running when in flight and nothing failed", () => {
    expect(stageStatus([job("success"), job("running")])).toBe("running");
  });

  it("is pending when only queued (created/pending) and none running", () => {
    expect(stageStatus([job("success"), job("pending")])).toBe("pending");
    expect(stageStatus([job("created")])).toBe("pending");
  });

  it("is success when every job is a clean finish", () => {
    expect(stageStatus([job("success"), job("skipped"), job("manual")])).toBe("success");
  });

  it("is canceled when finished with a canceled job and no clean all-green", () => {
    expect(stageStatus([job("success"), job("canceled")])).toBe("canceled");
    expect(stageStatus([job("cancelled")])).toBe("canceled");
  });

  it("is empty for no jobs", () => {
    expect(stageStatus([])).toBe("");
  });
});

describe("ciStatusVisual", () => {
  it("gives passed and failed solid green/red", () => {
    expect(ciStatusVisual("success")).toMatchObject({ dot: "bg-emerald-500", label: "passed" });
    expect(ciStatusVisual("failed")).toMatchObject({ dot: "bg-red-500", label: "failed" });
  });

  it("distinguishes running (blue, pulsing) from pending (amber, static)", () => {
    expect(ciStatusVisual("running")).toMatchObject({ pulse: true, label: "running" });
    const pending = ciStatusVisual("pending");
    expect(pending.pulse).toBe(false);
    expect(pending.label).toBe("pending");
    expect(pending.dot).not.toBe(ciStatusVisual("running").dot);
  });

  it("groups every waiting flavor under pending", () => {
    for (const s of ["pending", "created", "scheduled", "waiting_for_resource", "preparing"]) {
      expect(ciStatusVisual(s).label).toBe("pending");
    }
  });

  it("distinguishes canceled from skipped and manual", () => {
    const canceled = ciStatusVisual("canceled");
    const skipped = ciStatusVisual("skipped");
    const manual = ciStatusVisual("manual");
    expect(canceled.label).toBe("canceled");
    expect(ciStatusVisual("cancelled").label).toBe("canceled");
    // canceled is a solid fill; skipped/manual are hollow rings — all distinct.
    expect(new Set([canceled.dot, skipped.dot, manual.dot]).size).toBe(3);
    expect(skipped.dot).toContain("bg-transparent");
    expect(manual.dot).toContain("bg-transparent");
  });

  it("falls back to a gray dot labeled with the raw status", () => {
    expect(ciStatusVisual("weird")).toMatchObject({ dot: "bg-neutral-600", label: "weird" });
    expect(ciStatusVisual("")).toMatchObject({ label: "unknown" });
  });
});
