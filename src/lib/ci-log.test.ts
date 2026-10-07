import { describe, it, expect } from "vitest";
import type { ForgeJob, ForgeLogSection } from "@/ipc/types";
import {
  agentPrompt,
  ansiLines,
  defaultJob,
  defaultSection,
  formatDuration,
  jobDurationSecs,
  pipelineSpanSecs,
} from "./ci-log";

function job(p: Partial<ForgeJob>): ForgeJob {
  return {
    id: 1, name: "test", stage: "test", status: "success", retried: false,
    attempt: 1, startedAt: null, finishedAt: null, webUrl: "", allowFailure: false, ...p,
  };
}

function sec(name: string, text = "", status: string | null = null): ForgeLogSection {
  return { name, text, durationSecs: null, status };
}

describe("formatDuration", () => {
  it("scales units", () => {
    expect(formatDuration(6)).toBe("6s");
    expect(formatDuration(102)).toBe("1m 42s");
    expect(formatDuration(3780)).toBe("1h 3m");
  });
});

describe("durations", () => {
  it("measures finished jobs and running jobs up to now", () => {
    const start = "2026-01-01T00:00:00Z";
    expect(jobDurationSecs(job({ startedAt: start, finishedAt: "2026-01-01T00:01:42Z" }))).toBe(102);
    const now = Date.parse("2026-01-01T00:00:30Z");
    expect(jobDurationSecs(job({ startedAt: start, status: "running" }), now)).toBe(30);
    expect(jobDurationSecs(job({}))).toBeNull();
  });

  it("spans the pipeline from first start to last finish", () => {
    const jobs = [
      job({ startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:48Z" }),
      job({ startedAt: "2026-01-01T00:00:50Z", finishedAt: "2026-01-01T00:04:12Z" }),
      job({ status: "skipped" }),
    ];
    expect(pipelineSpanSecs(jobs)).toBe(252);
    expect(pipelineSpanSecs([job({ status: "skipped" })])).toBeNull();
  });
});

describe("defaultJob", () => {
  it("prefers a real failure over running and allowed failures", () => {
    const allowed = job({ id: 1, status: "failed", allowFailure: true });
    const running = job({ id: 2, status: "running" });
    const failed = job({ id: 3, status: "failed" });
    expect(defaultJob([allowed, running, failed])?.id).toBe(3);
    expect(defaultJob([allowed, running])?.id).toBe(2);
    expect(defaultJob([allowed, job({ id: 4 })])?.id).toBe(1);
  });
});

describe("defaultSection", () => {
  it("opens GitHub's failed step", () => {
    expect(defaultSection([sec("Set up", "", "success"), sec("Test", "", "failed"), sec("Post", "", "success")], "failed")).toBe(1);
  });
  it("opens GitLab's script section for a failed job", () => {
    const s = [sec(""), sec("Preparing"), sec("Executing step_script"), sec("Uploading artifacts"), sec("")];
    expect(defaultSection(s, "failed")).toBe(2);
  });
  it("opens the last section while running, none when passed", () => {
    expect(defaultSection([sec("a"), sec("b")], "running")).toBe(1);
    expect(defaultSection([sec("a"), sec("b")], "success")).toBe(-1);
  });
});

describe("ansiLines", () => {
  it("carries a style across a line break", () => {
    const lines = ansiLines("\x1b[31mred\nstill red\x1b[0m plain");
    expect(lines).toHaveLength(2);
    expect(lines[1][0].text).toBe("still red");
    expect(lines[1][0].style?.color).toBe(lines[0][0].style?.color);
    expect(lines[1][1].style?.color).toBeUndefined();
  });
});

describe("agentPrompt", () => {
  it("sends just the failing section, as plain text", () => {
    const sections = [sec("Set up", "boot", "success"), sec("Test", "\x1b[31mpanicked\x1b[0m", "failed")];
    const p = agentPrompt(job({ name: "cargo test", status: "failed" }), sections, 1);
    expect(p).toContain("The CI job `cargo test` failed (step `Test`).");
    expect(p).toContain("```\npanicked\n```");
    expect(p).not.toContain("boot");
  });
});
