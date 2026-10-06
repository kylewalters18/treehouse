import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  emptyDiff,
  fakeMainClone,
  fakeWorktree,
  FAKE_WORKSPACE,
  openWorktree,
} from "./helpers";

const HISTORY = [
  {
    sessionId: "7f3c2a1e-0b9d-4c8e-9f21-3a5b6c7d8e9f",
    backend: "claudeCode",
    title: "Wire LSP diagnostics into the gutter",
    lastMessage: "Diagnostics now render as squiggles.",
    startedAt: Date.now() - 60 * 60_000,
    lastActiveAt: Date.now() - 12 * 60_000,
    liveAgentId: null,
  },
  {
    sessionId: "0a1b2c3d-0000-4000-8000-000000000002",
    backend: "kiro",
    title: "Add backoff to the CI poller",
    lastMessage: "Tests pass.",
    startedAt: Date.now() - 5 * 60 * 60_000,
    lastActiveAt: Date.now() - 2 * 60 * 60_000,
    liveAgentId: null,
  },
];

/// Boot into a worktree with no running agents and two saved
/// conversations. Returns the args of every `launch_agent` call.
async function setup(page: Page) {
  const feature = fakeWorktree();
  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [fakeMainClone(), feature],
    get_diff: emptyDiff(),
    list_agent_activity: [],
    list_agents_for_worktree: [],
    list_backend_agents: [],
    list_agent_history: HISTORY,
  });
  await page.evaluate((worktreeId) => {
    const w = window as unknown as {
      __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
      __launches: unknown[];
    };
    w.__launches = [];
    w.__e2e.mock("launch_agent", (args: unknown) => {
      w.__launches.push(args);
      return {
        id: "01HZE2ESTAGENT00000000000R",
        worktreeId,
        backend: "claudeCode",
        argv: ["claude"],
        startedAt: 1,
        cols: 80,
        rows: 24,
        status: { kind: "running" },
        resumed: true,
      };
    });
    w.__e2e.mock("agent_resize", () => null);
    w.__e2e.mock("agent_write", () => null);
  }, feature.id);

  await page.getByRole("button", { name: /open repository/i }).click();
  await openWorktree(page, "agent/feature");
}

function launches(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __launches: { resume?: string; backend: string }[] })
        .__launches,
  );
}

test("empty agent pane offers saved sessions and resumes one with its backend", async ({
  page,
}) => {
  await setup(page);
  await expect(page.getByText("Resume a recent session")).toBeVisible();
  await page.getByText("Add backoff to the CI poller").click();

  await expect(page.getByTitle("Resumed conversation")).toBeVisible();
  await expect
    .poll(async () => (await launches(page)).map((l) => [l.backend, l.resume]))
    .toEqual([["kiro", "0a1b2c3d-0000-4000-8000-000000000002"]]);
});

test("history menu lists sessions and forgets one", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as unknown as {
      __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
      __forgot: unknown[];
    };
    w.__forgot = [];
    w.__e2e.mock("forget_agent_session", (args: unknown) => {
      w.__forgot.push(args);
      return null;
    });
  });

  await page.getByTitle("Recent agent sessions in this worktree").click();
  const menu = page.getByText("Recent sessions", { exact: true }).locator("../..");
  await expect(menu.getByText("Wire LSP diagnostics into the gutter")).toBeVisible();

  await menu.getByText("Wire LSP diagnostics into the gutter").hover();
  await menu.getByTitle("Remove from history").first().click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __forgot: unknown[] }).__forgot),
    )
    .toEqual([{ sessionId: "7f3c2a1e-0b9d-4c8e-9f21-3a5b6c7d8e9f" }]);
});
