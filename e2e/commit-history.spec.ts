import { test, expect } from "@playwright/test";
import {
  bootApp,
  emptyDiff,
  fakeMainClone,
  fakeWorktree,
  FAKE_WORKSPACE,
  openWorktree,
} from "./helpers";

const SHA_A = "aaaaaaa1111111111111111111111111111111111";
const SHA_B = "bbbbbbb2222222222222222222222222222222222";
const BASE = "ccccccc3333333333333333333333333333333333";

/// History tab: lists the branch's commits, opening one lists its files,
/// and picking a file shows that commit's diff (parent → commit blobs,
/// never the workdir) with no review-comment affordances.
test("history tab: commit → files → per-commit diff", async ({ page }) => {
  const feature = fakeWorktree();
  const commit = (sha: string, summary: string) => ({
    sha,
    shortSha: sha.slice(0, 7),
    summary,
    message: summary,
    author: "Test",
    time: Date.now() - 3_600_000,
    merge: false,
    stats: { filesChanged: 1, insertions: 1, deletions: 1 },
  });
  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [fakeMainClone(), feature],
    get_diff: emptyDiff(),
    list_agent_activity: [],
    list_agents_for_worktree: [],
    list_tree: [],
    list_branch_commits: {
      anchor: BASE,
      commits: [commit(SHA_B, "Second change"), commit(SHA_A, "First change")],
      truncated: false,
    },
  });
  await page.evaluate(
    ({ SHA_A, SHA_B }) => {
      const w = window as unknown as {
        __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
        __blobReads: string[];
      };
      w.__blobReads = [];
      w.__e2e.mock("get_commit_diff", (args) => {
        const { sha } = args as { sha: string };
        return {
          worktreeId: "",
          baseRef: sha === SHA_A ? "parent-a" : SHA_A,
          computedAt: 0,
          stats: { filesChanged: 1, insertions: 1, deletions: 1 },
          files: [
            {
              path: sha === SHA_A ? "first.rs" : "second.rs",
              status: { kind: "modified" },
              hunks: [],
              binary: false,
              insertions: 1,
              deletions: 1,
            },
          ],
          truncated: false,
        };
      });
      w.__e2e.mock("read_blob_at_ref", (args) => {
        const { reference } = args as { reference: string };
        w.__blobReads.push(reference);
        return reference === SHA_B ? "fn after() {}\n" : "fn before() {}\n";
      });
      w.__e2e.mock("read_file", () => {
        throw new Error("commit diffs must not read the workdir");
      });
    },
    { SHA_A, SHA_B },
  );

  await page.getByRole("button", { name: /open repository/i }).click();
  await openWorktree(page, "agent/feature");

  const historyTab = page.getByRole("button", { name: /^History/ });
  await historyTab.click();
  await expect(historyTab).toContainText("2");
  await expect(page.getByText("Select a commit to see its changes.")).toBeVisible();

  await page.getByRole("button", { name: /Second change/ }).click();
  await expect(page.getByText("in bbbbbbb", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /second\.rs/ })).toBeVisible();

  // Opening the commit auto-selects its file and shows the commit diff.
  await expect(page.getByText("· in bbbbbbb")).toBeVisible();
  await expect(page.getByLabel("Comment on file")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __blobReads: string[] }).__blobReads),
    )
    .toEqual(expect.arrayContaining([SHA_A, SHA_B]));

  // Switching commits swaps the file list.
  await page.getByRole("button", { name: /First change/ }).click();
  await expect(page.getByRole("button", { name: /first\.rs/ })).toBeVisible();
  await expect(page.getByText("· in aaaaaaa")).toBeVisible();
});
