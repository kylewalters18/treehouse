import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  emptyDiff,
  fakeMainClone,
  fakeWorktree,
  FAKE_WORKSPACE,
  openWorktree,
} from "./helpers";

const ISSUES = [
  {
    number: 212,
    title: "Inlay hints for rust-analyzer",
    body: "Add inlay hints.",
    state: "open",
    labels: ["lsp", "editor"],
    assignees: [],
    url: "https://github.com/acme/repo/issues/212",
    updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  },
  {
    number: 219,
    title: "Indexing progress in the status bar",
    body: "",
    state: "open",
    labels: ["lsp"],
    assignees: [],
    url: "https://github.com/acme/repo/issues/219",
    updatedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
  },
];

const HISTORY = [
  {
    sessionId: "7f3c2a1e-0b9d-4c8e-9f21-3a5b6c7d8e9f",
    backend: "claudeCode",
    title: "LSP gaps — inlay hints + indexing progress",
    lastMessage: null,
    startedAt: Date.now() - 60 * 60_000,
    lastActiveAt: Date.now() - 12 * 60_000,
    liveAgentId: null,
  },
];

type Recorded = { open: Record<string, unknown>[]; issues: Record<string, unknown>[] };

/// Boot into a repo with a forge, issues and a past planning session.
/// Records `open_planner` and `forge_list_issues` args.
async function setup(page: Page) {
  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [fakeMainClone(), fakeWorktree()],
    get_diff: emptyDiff(),
    list_agent_activity: [],
    list_agents_for_worktree: [],
    list_backend_agents: [],
    list_agent_history: [],
    list_planner_history: HISTORY,
    planner_activities: [],
    planner_commits_behind: 3,
    forge_status: {
      kind: "github",
      host: "github.com",
      installed: true,
      authenticated: true,
      username: "me",
    },
    agent_resize: null,
    agent_write: null,
  });
  await page.evaluate(
    ({ issues, ws }) => {
      const w = window as unknown as {
        __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
        __rec: Recorded;
      };
      w.__rec = { open: [], issues: [] };
      w.__e2e.mock("open_planner", (args) => {
        w.__rec.open.push(args as Record<string, unknown>);
        return {
          session: {
            id: "01HZE2ESTPLANNER000000000P",
            worktreeId: "01HZE2ESTPLANNERWT0000000P",
            backend: "claudeCode",
            argv: ["claude"],
            startedAt: 1,
            cols: 80,
            rows: 24,
            status: { kind: "running" },
            resumed: false,
          },
          checkout: { baseRef: "origin/main", sha: "84ae864", warning: null },
        };
      });
      w.__e2e.mock("forge_list_issues", (args) => {
        const a = args as { labels: string[] | null; workspaceId: string };
        w.__rec.issues.push(a as unknown as Record<string, unknown>);
        void ws;
        return a.labels?.length
          ? issues.filter((i) => a.labels!.every((l) => i.labels.includes(l)))
          : issues;
      });
    },
    { issues: ISSUES, ws: FAKE_WORKSPACE.id },
  );
  await page.getByRole("button", { name: /open repository/i }).click();
  await openWorktree(page, "agent/feature");
}

const recorded = (page: Page) =>
  page.evaluate(() => (window as unknown as { __rec: Recorded }).__rec);

test("planner opens on a landing view and its prompt starts the session", async ({ page }) => {
  await setup(page);
  await page.keyboard.press("Meta+j");
  const dialog = page.getByRole("dialog", { name: "Planner" });
  await expect(dialog.getByRole("heading", { name: "Plan in repo" })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: /repo/ })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tab", { name: /Global/ })).toBeVisible();
  await expect(dialog.getByText("LSP gaps — inlay hints + indexing progress")).toBeVisible();
  // Nothing launched until the user starts.
  expect((await recorded(page)).open).toEqual([]);

  await dialog.getByLabel("Start planning").fill("plan the LSP work");
  await dialog.getByLabel("Start planning").press("Enter");
  await expect.poll(async () => (await recorded(page)).open.length).toBe(1);
  const args = (await recorded(page)).open[0];
  expect(args.workspaceId).toBe(FAKE_WORKSPACE.id);
  expect(args.prompt).toBe("plan the LSP work");
  // New planner sessions run over ACP.
  expect(args.transport).toBe("acp");
  await expect(dialog.getByText("84ae864")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /3 new commits on origin\/main/ })).toBeVisible();
});

test("issue drawer filters by label and starts a worktree preselected", async ({ page }) => {
  await setup(page);
  await page.keyboard.press("Meta+j");
  const dialog = page.getByRole("dialog", { name: "Planner" });
  await dialog.getByRole("button", { name: "Issues" }).click();
  const drawer = dialog.getByRole("complementary", { name: "Issues" });
  await expect(drawer.getByText("Inlay hints for rust-analyzer")).toBeVisible();

  await drawer.getByRole("button", { name: "editor", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "label: editor ✕" })).toBeVisible();
  await expect(drawer.getByText("Indexing progress in the status bar")).toBeHidden();
  expect((await recorded(page)).issues.at(-1)?.labels).toEqual(["editor"]);

  // Clicking an issue shows its description; Insert on the landing view
  // goes into the prompt box.
  await drawer.getByText("Inlay hints for rust-analyzer").click();
  await expect(drawer.getByText("Add inlay hints.")).toBeVisible();
  await drawer.getByRole("button", { name: "Insert #212" }).click();
  await expect(dialog.getByLabel("Start planning")).toHaveValue(
    "#212 Inlay hints for rust-analyzer ",
  );

  await drawer.getByRole("button", { name: "Start worktree" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Inlay hints for rust-analyzer").first()).toBeVisible();
});

test("issue detail edits title and description with a stale-edit check", async ({ page }) => {
  await setup(page);
  await page.evaluate((issue) => {
    const w = window as unknown as {
      __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
      __updates: unknown[];
    };
    w.__updates = [];
    w.__e2e.mock("forge_get_issue", () => issue);
    w.__e2e.mock("forge_update_issue", (args) => {
      const a = args as { title: string; body: string };
      w.__updates.push(args);
      return { ...issue, title: a.title, body: a.body, updatedAt: new Date().toISOString() };
    });
  }, ISSUES[0]);

  await page.keyboard.press("Meta+j");
  const dialog = page.getByRole("dialog", { name: "Planner" });
  await dialog.getByRole("button", { name: "Issues" }).click();
  const drawer = dialog.getByRole("complementary", { name: "Issues" });
  await drawer.getByText("Inlay hints for rust-analyzer").click();
  await drawer.getByRole("button", { name: "Edit" }).click();
  await drawer.getByLabel("Issue title").fill("Inlay hints for rust-analyzer and pyright");
  await drawer.getByLabel("Issue description").fill("Both servers.");
  await drawer.getByRole("button", { name: "Save" }).click();

  await expect(drawer.getByRole("heading", { name: "Inlay hints for rust-analyzer and pyright" })).toBeVisible();
  await expect(drawer.getByText("Both servers.")).toBeVisible();
  const updates = await page.evaluate(
    () => (window as unknown as { __updates: Record<string, unknown>[] }).__updates,
  );
  expect(updates).toEqual([
    {
      workspaceId: FAKE_WORKSPACE.id,
      number: 212,
      title: "Inlay hints for rust-analyzer and pyright",
      body: "Both servers.",
      expectedUpdatedAt: ISSUES[0].updatedAt,
    },
  ]);
});
