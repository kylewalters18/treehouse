import { test, expect } from "@playwright/test";
import {
  bootApp,
  emptyDiff,
  fakeMainClone,
  fakeWorktree,
  FAKE_WORKSPACE,
  openWorktree,
} from "./helpers";

/// Local review with no forge: a comment written in the editor lands in the
/// Review tab as pending, and one Send hands the batch (summary first) to
/// the agent and moves the comment to Sent. The forge lookup is made to
/// fail outright — the Review tab must not wait on it.
test("local review: pending comment → Send to agent → Sent, without a forge", async ({
  page,
}) => {
  const feature = fakeWorktree();
  const agent = {
    id: "01HZE2ESTAGENT00000000000A",
    worktreeId: feature.id,
    backend: "claudeCode",
    argv: ["claude"],
    startedAt: 100,
    cols: 80,
    rows: 24,
    status: { kind: "running" },
  };
  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [fakeMainClone(), feature],
    get_diff: emptyDiff(),
    list_agent_activity: [],
    list_agents_for_worktree: [agent],
    list_backend_agents: [],
    list_tree: [{ name: "main.rs", path: "main.rs", isDir: false }],
    read_file: {
      text: "fn a() {}\nfn b() {}\nfn c() {}\n",
      size: 30,
      binary: false,
    },
  });
  await page.evaluate((agent) => {
    const w = window as unknown as {
      __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
      __writes: string[];
    };
    w.__writes = [];
    w.__e2e.mock("forge_find_mr_for_branch", () => {
      throw new Error("no forge configured");
    });
    w.__e2e.mock("save_comments", (args) => (args as { comments: unknown }).comments);
    w.__e2e.mock("attach_agent", () => agent);
    w.__e2e.mock("agent_resize", () => null);
    w.__e2e.mock("agent_write", () => null);
    // Sends go through Rust, which picks paste-into-PTY or ACP prompt.
    w.__e2e.mock("agent_submit_prompt", (args) => {
      w.__writes.push((args as { text: string }).text);
      return null;
    });
  }, agent);

  await page.getByRole("button", { name: /open repository/i }).click();
  await openWorktree(page, "agent/feature");
  await page.getByRole("button", { name: "main.rs" }).click();

  // Comment on line 2 via the gutter "+", save with ⌘↵ (not send).
  await page.locator(".treehouse-comment-plus").nth(1).click();
  await page.keyboard.type("Return a Result here.");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText("pending", { exact: true })).toBeVisible();

  // Review tab: badge counts it, pending list shows it with its anchor.
  const reviewTab = page.getByRole("button", { name: /^Review/ });
  await expect(reviewTab).toContainText("1");
  await reviewTab.click();
  await expect(page.getByTitle("Jump to this comment in the editor")).toHaveText(
    "main.rs:2",
  );

  await page
    .getByPlaceholder(/Summary for the agent/)
    .fill("Focus on error handling.");
  await page.getByRole("button", { name: /Send to agent/ }).click();

  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  await expect(page.getByText("No pending comments.", { exact: false })).toBeVisible();

  const written = await page.evaluate(
    () => (window as unknown as { __writes: string[] }).__writes.join(""),
  );
  expect(written.indexOf("Focus on error handling.")).toBeGreaterThanOrEqual(0);
  expect(written.indexOf("Focus on error handling.")).toBeLessThan(
    written.indexOf("[main.rs:2]"),
  );
  expect(written).toContain("Return a Result here.");
});

/// Shared setup for the comment-anchor specs: one worktree, one file, no
/// forge, comments persisted through a pass-through `save_comments`.
async function openFileForReview(
  page: import("@playwright/test").Page,
  opts: { base?: string; head: string; diff?: boolean },
) {
  const feature = fakeWorktree();
  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [fakeMainClone(), feature],
    get_diff: opts.diff
      ? {
          worktreeId: feature.id,
          baseRef: "main",
          stats: { filesChanged: 1, insertions: 1, deletions: 2 },
          files: [
            {
              path: "main.rs",
              status: { kind: "modified" },
              hunks: [],
              binary: false,
              insertions: 1,
              deletions: 2,
            },
          ],
        }
      : emptyDiff(),
    list_agent_activity: [],
    list_agents_for_worktree: [],
    list_tree: [{ name: "main.rs", path: "main.rs", isDir: false }],
    read_file: { text: opts.head, size: opts.head.length, binary: false },
    read_blob_at_ref: opts.base ?? opts.head,
  });
  await page.evaluate(() => {
    const w = window as unknown as {
      __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
    };
    w.__e2e.mock("forge_find_mr_for_branch", () => {
      throw new Error("no forge configured");
    });
    w.__e2e.mock("save_comments", (args) => (args as { comments: unknown }).comments);
  });
  await page.getByRole("button", { name: /open repository/i }).click();
  await openWorktree(page, "agent/feature");
}

test("range comment: multi-line selection + gutter click comments on the range", async ({
  page,
}) => {
  await openFileForReview(page, {
    head: "fn a() {}\nfn b() {}\nfn c() {}\nfn d() {}\n",
  });
  await page.getByRole("button", { name: "main.rs" }).click();
  await page.waitForFunction(() =>
    (window as unknown as { __monaco?: typeof import("monaco-editor") }).__monaco?.editor
      .getEditors()
      .some((e) => e.getModel()?.getValue().includes("fn d")),
  );
  // Select lines 2–3 the way dragging down the line numbers does (ends at
  // column 1 of line 4), then click the "+" on line 3.
  await page.evaluate(() => {
    const m = (window as unknown as { __monaco: typeof import("monaco-editor") }).__monaco;
    const ed = m.editor.getEditors().find((e) => e.getModel()?.getValue().includes("fn d"))!;
    ed.setSelection(new m.Selection(2, 1, 4, 1));
  });
  await page.locator(".treehouse-comment-plus").nth(2).click();
  await expect(page.getByText("· Lines 2–3")).toBeVisible();
  // One whole-line decoration element per covered line.
  await expect(page.locator(".treehouse-review-range")).toHaveCount(2);

  await page.keyboard.type("These two should be one function.");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText("main.rs:2–3", { exact: true })).toBeVisible();
});

test("file-level comment: Comment on file anchors to the whole file", async ({ page }) => {
  await openFileForReview(page, { head: "fn a() {}\n" });
  await page.getByRole("button", { name: "main.rs" }).click();
  await page.getByRole("button", { name: "Comment on file" }).click();
  await expect(page.getByText("· Whole file")).toBeVisible();
  await page.keyboard.type("Split this module up.");
  await page.keyboard.press("Meta+Enter");

  await page.getByRole("button", { name: /^Review/ }).click();
  await expect(page.getByTitle("Jump to this comment in the editor")).toHaveText("main.rs");
});

test("removed-line comment: hovering deleted code in the diff offers a +", async ({
  page,
}) => {
  await openFileForReview(page, {
    base: "fn a() {}\nfn gone() {}\nfn also_gone() {}\nfn b() {}\n",
    head: "fn a() {}\nfn b() {}\n",
    diff: true,
  });
  await page.getByRole("button", { name: /^Changes/ }).click();
  await page.getByRole("button", { name: /main\.rs/ }).first().click();
  await page.getByRole("button", { name: "Diff", exact: true }).click();

  const deleted = page.locator(".view-lines.line-delete").first();
  await expect(deleted).toBeVisible();
  const box = (await deleted.boundingBox())!;
  // Second deleted row → base line 3.
  await page.mouse.move(box.x + 40, box.y + 18 + 9);
  const plus = page.getByRole("button", { name: "Comment on removed line" });
  await expect(plus).toBeVisible();
  await plus.click();
  await expect(page.getByText("· Removed · line 3")).toBeVisible();

  await page.keyboard.type("Why was this dropped?");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText("removed", { exact: true })).toBeVisible();
  await expect(page.getByText("main.rs:3", { exact: true })).toBeVisible();
});
