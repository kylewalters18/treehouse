import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  emptyDiff,
  fakeMainClone,
  fakeWorktree,
  FAKE_WORKSPACE,
} from "./helpers";

const FEATURE = fakeWorktree();
const DOCS = fakeWorktree({
  id: "01HZE2ESTWORKTREE0000000DOC",
  path: "/fake/repo__worktrees/docs",
  branch: "docs-refresh",
});

function session(id: string, worktreeId: string, startedAt: number) {
  return {
    id,
    worktreeId,
    backend: "claudeCode",
    argv: ["claude"],
    startedAt,
    cols: 80,
    rows: 24,
    status: { kind: "running" },
  };
}

const BLOCKED = "01HZE2ESTAGENT0000000BLOCK";
const DONE = "01HZE2ESTAGENT00000000DONE";
const BUSY = "01HZE2ESTAGENT00000000BUSY";

function overviews() {
  const now = Date.now();
  return [
    {
      session: session(BLOCKED, FEATURE.id, 100),
      activity: "needsAttention",
      changedAt: now - 42_000,
      title: "Rate limiting for the public API",
      task: "Add a Redis-backed rate limiter",
      currentTool: null,
      lastMessage: null,
      pending: {
        kind: "permission",
        toolName: "Bash",
        detail: "docker compose up -d redis",
      },
      canAnswerInline: true,
      diffStats: { filesChanged: 6, insertions: 214, deletions: 38 },
    },
    {
      session: session(DONE, DOCS.id, 200),
      activity: "idle",
      changedAt: now - 6 * 60_000,
      title: null,
      task: "Refresh the README",
      currentTool: null,
      lastMessage: "Rewrote the install section and fixed three dead links.",
      pending: null,
      canAnswerInline: false,
      diffStats: { filesChanged: 1, insertions: 40, deletions: 12 },
    },
    {
      session: session(BUSY, FEATURE.id, 300),
      activity: "working",
      changedAt: now - 3_000,
      title: null,
      task: "Instrument db calls",
      currentTool: "Edit: src/db/pool.rs",
      lastMessage: null,
      pending: null,
      canAnswerInline: false,
      diffStats: { filesChanged: 6, insertions: 214, deletions: 38 },
    },
  ];
}

async function openWorkspaceWithAgents(page: Page) {
  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [fakeMainClone(), FEATURE, DOCS],
    get_diff: emptyDiff(),
    list_agent_activity: [],
    list_agents_for_worktree: [],
    list_backend_agents: [],
    list_agent_overview: overviews(),
  });
  await page.evaluate(() => {
    const w = window as unknown as {
      __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
      __responses: unknown[];
    };
    w.__responses = [];
    w.__e2e.mock("agent_respond_permission", (args) => {
      w.__responses.push(args);
      return null;
    });
  });
  await page.getByRole("button", { name: /open repository/i }).click();
  await expect(page.getByTitle("Main clone (repo root)")).toBeVisible();
}

test("⌘K opens the board with agents sorted by what needs you", async ({
  page,
}) => {
  await openWorkspaceWithAgents(page);
  await page.keyboard.press("Meta+K");

  const board = page.getByRole("dialog", { name: "Agent board" });
  await expect(board).toBeVisible();
  await expect(board.getByText("Needs you")).toBeVisible();
  await expect(board.getByText("docker compose up -d redis")).toBeVisible();
  // Claude's conversation title heads the card, with the last prompt under it.
  await expect(board.getByText("Rate limiting for the public API")).toBeVisible();
  await expect(board.getByText("Add a Redis-backed rate limiter")).toBeVisible();
  await expect(
    board.getByText("Rewrote the install section and fixed three dead links."),
  ).toBeVisible();
  await expect(board.getByText("Edit: src/db/pool.rs")).toBeVisible();
  // Two Claude sessions in one worktree get their own cards and numbers.
  await expect(board.getByText("Claude 2", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(board).toBeHidden();
});

test("a answers the selected permission prompt from the board", async ({
  page,
}) => {
  await openWorkspaceWithAgents(page);
  await page.keyboard.press("Meta+K");
  const board = page.getByRole("dialog", { name: "Agent board" });
  await expect(board.getByText("docker compose up -d redis")).toBeVisible();

  // The longest-waiting blocked agent is selected on open.
  await page.keyboard.press("a");
  await expect(async () => {
    const got = await page.evaluate(
      () => (window as unknown as { __responses: unknown[] }).__responses,
    );
    expect(got).toEqual([{ agentId: BLOCKED, allow: true }]);
  }).toPass({ timeout: 2000 });
});

test("enter on a card jumps to that worktree and closes the board", async ({
  page,
}) => {
  await openWorkspaceWithAgents(page);
  await page.keyboard.press("Meta+K");
  const board = page.getByRole("dialog", { name: "Agent board" });
  await expect(board).toBeVisible();

  // Move from the blocked card to the finished docs agent, then open it.
  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  await expect(board).toBeHidden();
  await expect(
    page.getByRole("listitem", { name: "/fake/repo__worktrees/docs" }),
  ).toHaveAttribute("aria-current", "true");
});
