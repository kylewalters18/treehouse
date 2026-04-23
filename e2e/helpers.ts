import type { Page } from "@playwright/test";

/// Wait for the E2E harness (`window.__e2e`) to be installed, then
/// optionally seed a batch of static command responses. Most tests only
/// need static responses (command X → payload Y); tests that want
/// dynamic behaviour should call `page.evaluate` with `e2e.mock(...)`
/// directly.
export async function bootApp(
  page: Page,
  responses: Record<string, unknown> = {},
): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(
    () => !!(window as unknown as { __e2e?: unknown }).__e2e,
    null,
    { timeout: 5000 },
  );
  if (Object.keys(responses).length > 0) {
    await mockCommands(page, responses);
  }
}

/// Register static mocks for a list of commands. `response` is returned
/// as-is to every call of the command until overridden.
export async function mockCommands(
  page: Page,
  responses: Record<string, unknown>,
): Promise<void> {
  await page.evaluate((r) => {
    const w = window as unknown as {
      __e2e: {
        mock: (cmd: string, fn: () => unknown) => void;
      };
    };
    for (const [cmd, resp] of Object.entries(r)) {
      w.__e2e.mock(cmd, () => resp);
    }
  }, responses);
}

/// Emit a Tauri-style event to any `listen()` subscribers. Use e.g. to
/// fake a `diff://{id}/updated` push that drives the live-refresh path.
export async function emitEvent(
  page: Page,
  event: string,
  payload: unknown,
): Promise<void> {
  await page.evaluate(
    ({ e, p }) => {
      (
        window as unknown as {
          __e2e: { emit: (event: string, payload: unknown) => void };
        }
      ).__e2e.emit(e, p);
    },
    { e: event, p: payload },
  );
}

/// A synthetic Workspace payload. ULIDs are opaque strings to the
/// frontend; anything unique + 26-char-shape works.
export const FAKE_WORKSPACE = {
  id: "01HZE2ESTWORKSPACE0000000AA",
  root: "/fake/repo",
  defaultBranch: "main",
} as const;

export function fakeWorktree(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "01HZE2ESTWORKTREE0000000AAA",
    workspaceId: FAKE_WORKSPACE.id,
    path: "/fake/repo__worktrees/feature",
    branch: "agent/feature",
    baseRef: "main",
    head: "abc1234",
    dirty: false,
    isMainClone: false,
    ...overrides,
  };
}

export function fakeMainClone() {
  return fakeWorktree({
    id: "01HZE2ESTWORKTREE0000000MAIN",
    path: FAKE_WORKSPACE.root,
    branch: "main",
    isMainClone: true,
  });
}

export function emptyDiff() {
  return {
    worktreeId: "01HZE2ESTWORKTREE0000000AAA",
    baseRef: "main",
    stats: { filesChanged: 0, insertions: 0, deletions: 0 },
    files: [],
  };
}
