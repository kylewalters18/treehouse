import { test, expect } from "@playwright/test";
import {
  bootApp,
  emptyDiff,
  fakeMainClone,
  fakeWorktree,
  FAKE_WORKSPACE,
  openWorktree,
} from "./helpers";

const HEAD = "abc1234def5678abc1234def5678abc1234def56";

function job(p: Record<string, unknown>) {
  return {
    retried: false,
    attempt: 1,
    startedAt: null,
    finishedAt: null,
    webUrl: "",
    allowFailure: false,
    ...p,
  };
}

const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

/// CI tab: opens on the failing job with its failing section expanded,
/// searches the log, and switches runs from the history strip.
test("ci tab: failing job, sections, search, run history", async ({ page }) => {
  const feature = fakeWorktree({ head: HEAD });
  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [fakeMainClone(), feature],
    get_diff: emptyDiff(),
    list_agent_activity: [],
    list_agents_for_worktree: [],
    list_tree: [],
    forge_list_pipelines: [
      {
        id: 4821,
        refName: "agent/feature",
        sha: HEAD,
        status: "failed",
        webUrl: "https://example.test/p/4821",
        createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        title: "fix(diff): keep scroll position on recompute",
      },
      {
        id: 4820,
        refName: "agent/feature",
        sha: "0000000aaaaaaa",
        status: "success",
        webUrl: "https://example.test/p/4820",
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        title: "feat(diff): older change",
      },
    ],
  });
  await page.evaluate(
    ({ jobs }) => {
      const w = window as unknown as {
        __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
      };
      w.__e2e.mock("forge_pipeline_jobs", (args) => {
        const { pipelineId } = args as { pipelineId: number };
        return pipelineId === 4821 ? jobs : [jobs[0]];
      });
      w.__e2e.mock("forge_job_log", (args) => {
        const { jobId } = args as { jobId: number };
        if (jobId !== 12) return { sections: [{ name: "", text: "ok", durationSecs: null, status: null }], truncated: false };
        return {
          truncated: false,
          sections: [
            { name: "", text: "Running with gitlab-runner 17.0", durationSecs: null, status: null },
            { name: "Preparing the executor", text: "Using docker executor", durationSecs: 3, status: null },
            { name: "Restoring cache", text: "Restored cache for cargo", durationSecs: 8, status: null },
            {
              name: "Executing step_script",
              text:
                "\u001b[36m$ cargo test --locked\u001b[0m\n" +
                "test diff::compute::tests::renames ... \u001b[32mok\u001b[0m\n" +
                "test diff::compute::tests::untracked_files ... \u001b[31mFAILED\u001b[0m\n" +
                "\u001b[31mpanicked at src/diff/compute.rs:412:9: new.txt missing from DiffSet\u001b[0m\n" +
                "test result: FAILED. 241 passed; 1 failed",
              durationSecs: 102,
              status: null,
            },
            { name: "Uploading artifacts", text: "Uploading junit.xml", durationSecs: 1, status: null },
            { name: "", text: "\u001b[31mERROR: Job failed: exit code 101\u001b[0m", durationSecs: null, status: null },
          ],
        };
      });
    },
    {
      jobs: [
        job({ id: 1, name: "clippy", stage: "lint", status: "success", startedAt: t(0), finishedAt: t(48) }),
        job({ id: 2, name: "tsc", stage: "lint", status: "success", startedAt: t(1), finishedAt: t(32) }),
        job({ id: 10, name: "cargo test", stage: "test", status: "failed", startedAt: t(50), finishedAt: t(140) }),
        job({ id: 12, name: "cargo test", stage: "test", status: "failed", attempt: 2, startedAt: t(150), finishedAt: t(252) }),
        job({ id: 11, name: "vitest", stage: "test", status: "success", startedAt: t(50), finishedAt: t(72) }),
        job({ id: 13, name: "cargo audit", stage: "test", status: "failed", allowFailure: true, startedAt: t(50), finishedAt: t(59) }),
        job({ id: 20, name: "bundle macOS", stage: "build", status: "skipped" }),
        job({ id: 30, name: "draft release", stage: "release", status: "manual" }),
      ],
    },
  );

  await page.getByRole("button", { name: /open repository/i }).click();
  await openWorktree(page, "agent/feature");
  await page.getByRole("button", { name: /^CI/ }).click();

  // Summary: commit subject, span of the whole run, no stale-commit warning.
  await expect(page.getByText("fix(diff): keep scroll position on recompute")).toBeVisible();
  await expect(page.getByText("#4821 · 4m 12s")).toBeVisible();
  await expect(page.getByText("not HEAD")).toHaveCount(0);

  // The real failure (latest attempt) is selected, its script section open,
  // the others collapsed.
  await expect(page.getByText("test · attempt 2 · 1m 42s")).toBeVisible();
  await expect(page.getByText("allowed to fail")).toBeVisible();
  await expect(page.getByText(/new\.txt missing from DiffSet/)).toBeVisible();
  await expect(page.getByText("Using docker executor")).toHaveCount(0);
  await expect(page.getByText(/ERROR: Job failed/)).toBeVisible();

  await page.screenshot({ path: "test-results/ci-panel.png" });

  // Search opens the section holding a match.
  await page.getByLabel("Search log").fill("docker");
  await expect(page.getByText("Using docker executor")).toBeVisible();
  await expect(page.getByText("1/1")).toBeVisible();

  // Picking an older run from the strip shows it.
  await page.getByRole("button", { name: "Show pipeline 4820" }).click();
  await expect(page.getByText("feat(diff): older change")).toBeVisible();
  await expect(page.getByText("not HEAD")).toBeVisible();
});
