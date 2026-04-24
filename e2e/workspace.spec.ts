import { test, expect } from "@playwright/test";
import {
  bootApp,
  emptyDiff,
  fakeMainClone,
  fakeWorktree,
  FAKE_WORKSPACE,
  mockCommands,
} from "./helpers";

test("opening a workspace transitions to the Workspace route", async ({
  page,
}) => {
  await bootApp(page, {
    // Tauri v2 dialog plugin is invoked as `plugin:dialog|open`.
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [fakeMainClone()],
    get_diff: emptyDiff(),
    list_agent_activity: [],
  });

  await page.getByRole("button", { name: /open repository/i }).click();

  // Workspace route header has a Close button and the repo root in a
  // monospace badge. Both are reliable landmarks.
  await expect(page.getByRole("button", { name: /close/i })).toBeVisible();
  await expect(page.getByText(FAKE_WORKSPACE.root)).toBeVisible();
});

test("worktree sidebar renders main clone + feature worktree", async ({
  page,
}) => {
  const main = fakeMainClone();
  const feature = fakeWorktree();
  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [main, feature],
    get_diff: emptyDiff(),
    list_agent_activity: [
      { worktreeId: main.id, activity: "inactive", ahead: 0, behind: 0, dirty: false, merged: false },
      { worktreeId: feature.id, activity: "inactive", ahead: 0, behind: 0, dirty: false, merged: false },
    ],
  });

  await page.getByRole("button", { name: /open repository/i }).click();

  // Sidebar shows the main-clone entry and the feature worktree.
  // Scope the 'main' match to the sidebar to avoid colliding with the
  // default-branch badge in the header.
  await expect(
    page.getByRole("button", { name: /main clone/i }),
  ).toBeVisible();
  await expect(page.getByText("agent/feature")).toBeVisible();
});

test("selecting a file in the tree renders Monaco with its content", async ({
  page,
}) => {
  const feature = fakeWorktree();
  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [fakeMainClone(), feature],
    get_diff: emptyDiff(),
    list_agent_activity: [],
    list_tree: [
      { name: "hello.py", path: "hello.py", isDir: false },
    ],
    read_file: {
      text: "import os\nimport json\n\nprint('hi')\n",
      size: 34,
      binary: false,
    },
  });

  await page.getByRole("button", { name: /open repository/i }).click();

  // Click the feature worktree in the sidebar.
  await page.getByText("agent/feature").click();

  // Click the file in the tree (rendered under the Files section of the
  // DiffPane left column).
  await page.getByRole("button", { name: "hello.py" }).click();

  // Monaco model for the opened file should exist. We do the assertion
  // through the editor API rather than DOM text because Monaco renders
  // lines in non-obvious ways (virtualized, tokenized).
  await page.waitForFunction(() => {
    const monaco = (window as unknown as { __monaco?: typeof import("monaco-editor") })
      .__monaco;
    if (!monaco) return false;
    const model = monaco.editor.getModels().find(
      (m) => m.uri.toString() === "file:///hello.py",
    );
    return !!model && model.getValue().includes("print('hi')");
  });
});

test("editor click places the cursor at the clicked position", async ({
  page,
}) => {
  // Regression net for the CSS-zoom / mouse-coord-desync class of bug.
  // We drive a real click on a text span inside Monaco and assert the
  // cursor ended up on the correct line — not pinned to col 1 or the
  // end of the file.
  const feature = fakeWorktree();
  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [fakeMainClone(), feature],
    get_diff: emptyDiff(),
    list_agent_activity: [],
    list_tree: [{ name: "hello.py", path: "hello.py", isDir: false }],
    read_file: {
      text: "line one\nline two\nline three\nline four\nline five\n",
      size: 50,
      binary: false,
    },
  });

  await page.getByRole("button", { name: /open repository/i }).click();
  await page.getByText("agent/feature").click();
  await page.getByRole("button", { name: "hello.py" }).click();

  // Wait for the Monaco model to be populated.
  await page.waitForFunction(() => {
    const monaco = (window as unknown as { __monaco?: typeof import("monaco-editor") })
      .__monaco;
    const model = monaco?.editor
      .getModels()
      .find((m) => m.uri.toString() === "file:///hello.py");
    return !!model && model.getLineCount() >= 5;
  });

  // Click somewhere deliberate on line 3 ("line three"). Monaco renders
  // content inside `.view-line` DOM rows; we click the third one at a
  // horizontal offset inside the text.
  const line = page.locator(".view-line").nth(2);
  const box = await line.boundingBox();
  if (!box) throw new Error("no bounding box for view-line");
  await page.mouse.click(box.x + 20, box.y + box.height / 2);

  const pos = await page.evaluate(() => {
    const monaco = (window as unknown as { __monaco?: typeof import("monaco-editor") })
      .__monaco;
    const ed = monaco?.editor.getEditors()[0];
    const p = ed?.getPosition();
    return p ? { line: p.lineNumber, col: p.column } : null;
  });
  expect(pos?.line).toBe(3);
  expect(pos?.col).toBeGreaterThanOrEqual(1);
});
