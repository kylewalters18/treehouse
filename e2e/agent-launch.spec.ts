import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  emptyDiff,
  fakeMainClone,
  fakeWorktree,
  FAKE_WORKSPACE,
  openWorktree,
} from "./helpers";

type Launch = { backend: string; argv?: string[] };

/// Boot into an empty agent pane with one repo-scoped launch profile.
/// Records every `launch_agent` and `agent_profile_save` call.
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
    list_agent_history: [],
  });
  await page.evaluate((worktreeId) => {
    const w = window as unknown as {
      __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
      __launches: unknown[];
      __saved: unknown[];
    };
    w.__launches = [];
    w.__saved = [];
    const profiles: unknown[] = [
      {
        workspace: "/fake/repo",
        name: "Reviewer",
        backend: "claudeCode",
        command: "claude --agent reviewer",
      },
    ];
    w.__e2e.mock("agent_profiles_list", () => profiles);
    w.__e2e.mock("agent_profile_save", (args: unknown) => {
      const p = (args as { profile: unknown }).profile;
      w.__saved.push(p);
      profiles.unshift(p);
      return null;
    });
    w.__e2e.mock("launch_agent", (args: unknown) => {
      w.__launches.push(args);
      const a = args as { backend: string; argv?: string[] };
      return {
        id: `01HZE2ESTAGENT0000000000${w.__launches.length}0`,
        worktreeId,
        backend: a.backend,
        argv: a.argv ?? ["claude"],
        startedAt: 1,
        cols: 80,
        rows: 24,
        status: { kind: "running" },
        resumed: false,
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
    () => (window as unknown as { __launches: Launch[] }).__launches,
  );
}

test("profile menu launches a repo profile and + repeats it", async ({ page }) => {
  await setup(page);
  await page.getByTitle("Choose a launch profile").click();
  await expect(page.getByText("This repo")).toBeVisible();
  await page.getByText("claude --agent reviewer").click();

  await expect(page.getByRole("tab", { name: /Reviewer 1/ })).toBeVisible();
  // `+` now launches the last-used profile for this repo.
  await page.getByTitle(/^Launch Reviewer/).click();
  await expect(page.getByRole("tab", { name: /Reviewer 2/ })).toBeVisible();
  await expect
    .poll(async () => (await launches(page)).map((l) => l.argv))
    .toEqual([
      ["claude", "--agent", "reviewer"],
      ["claude", "--agent", "reviewer"],
    ]);
});

test("edit & launch saves a new repo profile", async ({ page }) => {
  await setup(page);
  await page.getByTitle("Choose a launch profile").click();
  await page.getByText("Edit & launch…").click();

  const command = page.getByPlaceholder(/default command/);
  await command.fill("codex --model o5");
  await page.getByTitle("Codex").click();
  await page.getByPlaceholder(/Profile name/).fill("Fast");
  await page.getByRole("button", { name: "Save & launch" }).click();

  await expect(page.getByRole("tab", { name: /Fast 1/ })).toBeVisible();
  const saved = await page.evaluate(
    () => (window as unknown as { __saved: unknown[] }).__saved,
  );
  expect(saved).toEqual([
    { workspace: "/fake/repo", name: "Fast", backend: "codex", command: "codex --model o5" },
  ]);
  expect((await launches(page)).map((l) => [l.backend, l.argv])).toEqual([
    ["codex", ["codex", "--model", "o5"]],
  ]);
});
