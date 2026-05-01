import { test, expect, type Page } from "@playwright/test";
import {
  bootApp,
  emptyDiff,
  fakeMainClone,
  fakeWorktree,
  FAKE_WORKSPACE,
} from "./helpers";

/// Three pre-existing agents seeded via `list_agents_for_worktree` so
/// AgentPane adopts them as attach-mode tabs in `started_at` order.
function fakeAgents(worktreeId: string) {
  return [
    {
      id: "01HZE2ESTAGENT00000000000A",
      worktreeId,
      backend: "claudeCode",
      argv: ["claude"],
      startedAt: 100,
      cols: 80,
      rows: 24,
      status: { kind: "running" },
    },
    {
      id: "01HZE2ESTAGENT00000000000B",
      worktreeId,
      backend: "codex",
      argv: ["codex"],
      startedAt: 200,
      cols: 80,
      rows: 24,
      status: { kind: "running" },
    },
    {
      id: "01HZE2ESTAGENT00000000000C",
      worktreeId,
      backend: "kiro",
      argv: ["kiro-cli"],
      startedAt: 300,
      cols: 80,
      rows: 24,
      status: { kind: "running" },
    },
  ];
}

/// Read tab labels in DOM order from the AgentPane tab strip.
async function tabLabels(page: Page): Promise<string[]> {
  return await page
    .locator("[draggable='true'] .font-mono")
    .allTextContents();
}

/// Dispatch HTML5 drag events on the tab whose label matches `fromLabel`,
/// dropping onto the tab whose label matches `toLabel`. We can't use
/// Playwright's pointer-based `dragTo` because React's synthetic
/// `onDragStart` doesn't fire reliably from pointer simulation across
/// WebKit; explicit `DragEvent` dispatch with a shared `DataTransfer`
/// goes through the React handlers cleanly.
async function dragTab(
  page: Page,
  fromLabel: string,
  toLabel: string,
): Promise<void> {
  await page.evaluate(
    ({ fromLabel, toLabel }) => {
      function getTab(label: string): HTMLElement | null {
        const spans = Array.from(
          document.querySelectorAll("[draggable='true'] .font-mono"),
        );
        for (const s of spans) {
          if (s.textContent?.trim() === label) {
            return s.parentElement;
          }
        }
        return null;
      }
      const from = getTab(fromLabel);
      const to = getTab(toLabel);
      if (!from) throw new Error(`tab not found: ${fromLabel}`);
      if (!to) throw new Error(`tab not found: ${toLabel}`);
      const dt = new DataTransfer();
      from.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }),
      );
      to.dispatchEvent(
        new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }),
      );
      to.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          dataTransfer: dt,
          cancelable: true,
        }),
      );
      to.dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: dt }),
      );
      from.dispatchEvent(
        new DragEvent("dragend", { bubbles: true, dataTransfer: dt }),
      );
    },
    { fromLabel, toLabel },
  );
}

async function setupAgentsAndOpen(page: Page) {
  const feature = fakeWorktree();
  const agents = fakeAgents(feature.id);

  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [fakeMainClone(), feature],
    get_diff: emptyDiff(),
    list_agent_activity: [],
    list_agents_for_worktree: agents,
    list_backend_agents: [],
  });
  await page.evaluate((agents) => {
    const w = window as unknown as {
      __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
    };
    w.__e2e.mock("attach_agent", (args: unknown) => {
      const a = args as { agentId: string };
      return agents.find((x) => x.id === a.agentId);
    });
    w.__e2e.mock("agent_resize", () => null);
    w.__e2e.mock("agent_write", () => null);
  }, agents);

  await page.getByRole("button", { name: /open repository/i }).click();
  await page.getByText("agent/feature").click();

  await expect(page.getByText("Claude 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Codex 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Kiro 1", { exact: true })).toBeVisible();
}

test("agent tabs reorder via synthetic drag events", async ({ page }) => {
  await setupAgentsAndOpen(page);
  expect(await tabLabels(page)).toEqual(["Claude 1", "Codex 1", "Kiro 1"]);

  // Drop Kiro 1 onto Claude 1 → Kiro 1 takes Claude's slot, pushing
  // Claude/Codex right.
  await dragTab(page, "Kiro 1", "Claude 1");

  await expect(async () => {
    expect(await tabLabels(page)).toEqual(["Kiro 1", "Claude 1", "Codex 1"]);
  }).toPass({ timeout: 2000 });
});

test("agent tabs can be dragged forward to the last position", async ({
  page,
}) => {
  // Regression: dropping a tab onto the rightmost tab should land the
  // dragged tab AFTER it (becoming the new last tab). The earlier
  // implementation always inserted *before* the target, so the moved
  // tab couldn't reach the end of the strip.
  await setupAgentsAndOpen(page);
  expect(await tabLabels(page)).toEqual(["Claude 1", "Codex 1", "Kiro 1"]);

  // Forward drag: Claude 1 (idx 0) onto Kiro 1 (idx 2).
  await dragTab(page, "Claude 1", "Kiro 1");
  await expect(async () => {
    expect(await tabLabels(page)).toEqual(["Codex 1", "Kiro 1", "Claude 1"]);
  }).toPass({ timeout: 2000 });

  // Forward drag from the middle: Codex 1 (idx 0 now) onto Claude 1
  // (idx 2 now) — should also land Codex 1 last.
  await dragTab(page, "Codex 1", "Claude 1");
  await expect(async () => {
    expect(await tabLabels(page)).toEqual(["Kiro 1", "Claude 1", "Codex 1"]);
  }).toPass({ timeout: 2000 });
});

test("agent tabs reorder via real mouse drag", async ({ page }) => {
  // The synthetic-DragEvent path passes even when real native HTML5 DnD
  // is broken (different browser code path). This test simulates an
  // actual mouse-driven drag — what the user does — and is the
  // authoritative regression check for the reorder feature.
  await setupAgentsAndOpen(page);
  expect(await tabLabels(page)).toEqual(["Claude 1", "Codex 1", "Kiro 1"]);

  // Instrument the page so we can verify our drag handlers actually
  // fired. Without this, a Playwright `dragTo` that doesn't trigger
  // HTML5 events would silently leave the order intact and the test
  // would pass for the wrong reason on a different render.
  await page.evaluate(() => {
    const w = window as unknown as { __dragLog: string[] };
    w.__dragLog = [];
    const types = ["dragstart", "dragenter", "dragover", "drop", "dragend"];
    for (const t of types) {
      document.addEventListener(
        t,
        (ev) => {
          const tab = (ev.target as HTMLElement | null)?.closest(
            "[draggable='true']",
          );
          const label = tab?.querySelector(".font-mono")?.textContent?.trim();
          w.__dragLog.push(`${t}:${label ?? "?"}`);
        },
        true,
      );
    }
  });

  const kiroTab = page
    .locator("[draggable='true']")
    .filter({ hasText: "Kiro 1" });
  const claudeTab = page
    .locator("[draggable='true']")
    .filter({ hasText: "Claude 1" });

  await kiroTab.dragTo(claudeTab);

  const dragLog = await page.evaluate(
    () => (window as unknown as { __dragLog: string[] }).__dragLog,
  );
  console.log("[drag-log]", dragLog);

  // Assert we actually saw HTML5 drag events fire. If not, the test
  // simulator never invoked our handlers and the reorder claim is
  // unfounded — fail loudly instead of trusting a stale state.
  expect(dragLog.some((s) => s.startsWith("dragstart:Kiro 1"))).toBe(true);
  expect(dragLog.some((s) => s.startsWith("drop:Claude 1"))).toBe(true);

  await expect(async () => {
    expect(await tabLabels(page)).toEqual(["Kiro 1", "Claude 1", "Codex 1"]);
  }).toPass({ timeout: 2000 });
});

test("agent tab order persists across worktree switches", async ({ page }) => {
  const main = fakeMainClone();
  const feature = fakeWorktree();
  const agents = fakeAgents(feature.id);

  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [main, feature],
    get_diff: emptyDiff(),
    list_agent_activity: [],
    list_agents_for_worktree: agents,
    list_backend_agents: [],
  });
  await page.evaluate((agents) => {
    const w = window as unknown as {
      __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
    };
    w.__e2e.mock("attach_agent", (args: unknown) => {
      const a = args as { agentId: string };
      return agents.find((x) => x.id === a.agentId);
    });
    w.__e2e.mock("agent_resize", () => null);
    w.__e2e.mock("agent_write", () => null);
  }, agents);

  await page.getByRole("button", { name: /open repository/i }).click();
  await page.getByText("agent/feature").click();

  await expect(page.getByText("Kiro 1", { exact: true })).toBeVisible();
  await dragTab(page, "Kiro 1", "Claude 1");
  await expect(async () => {
    expect(await tabLabels(page)).toEqual(["Kiro 1", "Claude 1", "Codex 1"]);
  }).toPass({ timeout: 2000 });

  // Switch to main clone — AgentPane is hidden for the main clone.
  await page.getByRole("button", { name: /main clone/i }).click();
  // Switch back; order should be restored from the UI store.
  await page.getByText("agent/feature").click();

  await expect(page.getByText("Kiro 1", { exact: true })).toBeVisible();
  expect(await tabLabels(page)).toEqual(["Kiro 1", "Claude 1", "Codex 1"]);
});

test("agent tab labels are stable across worktree switches", async ({
  page,
}) => {
  // Three claude agents so the per-backend counter actually has work
  // to do. Labels should reflect agent identity (started-at order),
  // not display position — without this guarantee, dragging Claude 3
  // to the front and switching worktrees would relabel it to
  // "Claude 1" (and the original "Claude 1" would shift to "Claude 2",
  // etc), which is intensely confusing.
  const main = fakeMainClone();
  const feature = fakeWorktree();
  const agents = [
    {
      id: "01HZE2ESTAGENT00000000000A",
      worktreeId: feature.id,
      backend: "claudeCode",
      argv: ["claude"],
      startedAt: 100,
      cols: 80,
      rows: 24,
      status: { kind: "running" },
    },
    {
      id: "01HZE2ESTAGENT00000000000B",
      worktreeId: feature.id,
      backend: "claudeCode",
      argv: ["claude"],
      startedAt: 200,
      cols: 80,
      rows: 24,
      status: { kind: "running" },
    },
    {
      id: "01HZE2ESTAGENT00000000000C",
      worktreeId: feature.id,
      backend: "claudeCode",
      argv: ["claude"],
      startedAt: 300,
      cols: 80,
      rows: 24,
      status: { kind: "running" },
    },
  ];

  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [main, feature],
    get_diff: emptyDiff(),
    list_agent_activity: [],
    list_agents_for_worktree: agents,
    list_backend_agents: [],
  });
  await page.evaluate((agents) => {
    const w = window as unknown as {
      __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
    };
    w.__e2e.mock("attach_agent", (args: unknown) => {
      const a = args as { agentId: string };
      return agents.find((x) => x.id === a.agentId);
    });
    w.__e2e.mock("agent_resize", () => null);
    w.__e2e.mock("agent_write", () => null);
  }, agents);

  await page.getByRole("button", { name: /open repository/i }).click();
  await page.getByText("agent/feature").click();

  await expect(page.getByText("Claude 1", { exact: true })).toBeVisible();
  expect(await tabLabels(page)).toEqual(["Claude 1", "Claude 2", "Claude 3"]);

  // Drag Claude 3 to the front. Display order: [3, 1, 2]. Labels must
  // remain stable — Claude 3 is still Claude 3.
  await dragTab(page, "Claude 3", "Claude 1");
  await expect(async () => {
    expect(await tabLabels(page)).toEqual(["Claude 3", "Claude 1", "Claude 2"]);
  }).toPass({ timeout: 2000 });

  // Round-trip via the main clone (AgentPane unmounts and remounts).
  await page.getByRole("button", { name: /main clone/i }).click();
  await page.getByText("agent/feature").click();

  // Labels MUST still be ["Claude 3", "Claude 1", "Claude 2"], not
  // re-numbered to ["Claude 1", "Claude 2", "Claude 3"].
  await expect(page.getByText("Claude 3", { exact: true })).toBeVisible();
  expect(await tabLabels(page)).toEqual(["Claude 3", "Claude 1", "Claude 2"]);
});

test("active agent tab persists across worktree switches", async ({
  page,
}) => {
  const main = fakeMainClone();
  const feature = fakeWorktree();
  const agents = fakeAgents(feature.id);

  await bootApp(page, {
    "plugin:dialog|open": "/fake/repo",
    open_workspace: FAKE_WORKSPACE,
    list_worktrees: [main, feature],
    get_diff: emptyDiff(),
    list_agent_activity: [],
    list_agents_for_worktree: agents,
    list_backend_agents: [],
  });
  await page.evaluate((agents) => {
    const w = window as unknown as {
      __e2e: { mock: (cmd: string, fn: (args: unknown) => unknown) => void };
    };
    w.__e2e.mock("attach_agent", (args: unknown) => {
      const a = args as { agentId: string };
      return agents.find((x) => x.id === a.agentId);
    });
    w.__e2e.mock("agent_resize", () => null);
    w.__e2e.mock("agent_write", () => null);
  }, agents);

  await page.getByRole("button", { name: /open repository/i }).click();
  await page.getByText("agent/feature").click();

  // Default after adoption is the last tab — Kiro 1. Switch to Codex 1
  // explicitly so the test exercises the persisted-active code path.
  await page.getByText("Codex 1", { exact: true }).click();

  // Switch to main clone, then back.
  await page.getByRole("button", { name: /main clone/i }).click();
  await page.getByText("agent/feature").click();

  // Codex 1 should remain the active tab. The active tab uses
  // `bg-neutral-800` whereas inactive ones use neither bg nor text-100,
  // so we assert the class on the tab element.
  const codexTab = page
    .locator("[draggable='true']")
    .filter({ hasText: "Codex 1" });
  await expect(codexTab).toHaveClass(/bg-neutral-800/);
});
