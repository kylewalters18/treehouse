import { test, expect, type Page } from "@playwright/test";
import { bootApp, emptyDiff, fakeMainClone, fakeWorktree, FAKE_WORKSPACE } from "./helpers";

const now = () => Math.floor(Date.now() / 1000);

async function openDialog(page: Page) {
  const open = fakeWorktree({ branch: "already-open" });
  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [fakeMainClone(), open],
    get_diff: emptyDiff(),
    list_agent_activity: [],
    list_checkout_branches: [
      { name: "main", local: true, remote: true, updated: now() },
      { name: "kyle/fix-auth", local: false, remote: true, updated: now() - 3600 },
      { name: "kyle/fix-auth-v2", local: true, remote: false, updated: now() - 7200 },
      { name: "already-open", local: true, remote: true, updated: now() - 86400 },
    ],
  });
  // Record create calls instead of answering them.
  await page.evaluate(() => {
    const w = window as unknown as {
      __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
      __creates: unknown[];
    };
    w.__creates = [];
    w.__e2e.mock("create_worktree", (args) => {
      w.__creates.push(args);
      return new Promise(() => {});
    });
  });
  await page.getByRole("button", { name: /open repository/i }).click();
  await page.getByTitle("New worktree (⌘⇧N)").click();
  return page.getByLabel("Search issues or name a new branch");
}

test("lists recent branches, excluding the default branch", async ({ page }) => {
  await openDialog(page);
  await expect(page.getByText("Recent branches")).toBeVisible();
  await expect(page.getByRole("button", { name: /^kyle\/fix-auth\s/ })).toContainText("origin");
  await expect(page.getByRole("button", { name: /^already-open\s/ })).toContainText("open");
  await expect(page.getByRole("button", { name: /^main\s/ })).toHaveCount(0);
});

test("an exact branch name checks out the existing origin branch", async ({ page }) => {
  const input = await openDialog(page);
  await input.fill("kyle/fix-auth");
  // The exact match replaces "New branch" and is the Enter default.
  await expect(page.getByText(/^New branch/)).toHaveCount(0);
  const cta = page.getByRole("button", { name: "Check out origin/kyle/fix-auth" });
  await expect(cta).toBeVisible();
  await input.press("Enter");
  const creates = await page.evaluate(
    () => (window as unknown as { __creates: Array<{ name: string }> }).__creates,
  );
  expect(creates.map((c) => c.name)).toEqual(["kyle/fix-auth"]);
});

test("a valid branch name is kept verbatim for a new branch", async ({ page }) => {
  const input = await openDialog(page);
  await input.fill("JIRA-12_thing");
  await expect(page.getByText("JIRA-12_thing", { exact: true })).toBeVisible();
  await input.fill("Add README!");
  await expect(page.getByText("add-readme", { exact: true })).toBeVisible();
});

test("picking an already-open branch jumps instead of creating", async ({ page }) => {
  const input = await openDialog(page);
  await input.fill("already");
  await page.getByRole("button", { name: /^already-open\s/ }).click();
  await page.getByRole("button", { name: "Go to worktree" }).click();
  await expect(input).toHaveCount(0);
  const creates = await page.evaluate(
    () => (window as unknown as { __creates: unknown[] }).__creates,
  );
  expect(creates).toEqual([]);
});
