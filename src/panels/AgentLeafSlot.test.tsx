import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

// xterm and its addons reach into the DOM in ways jsdom can't honour
// (canvas, ResizeObserver, layout). Replace them with shape-compatible
// stand-ins — the test cares about the side-effect lifecycle, not what
// gets painted.
vi.mock("xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    buffer = { active: { viewportY: 0, baseY: 0 } };
    open() {}
    dispose() {}
    focus() {}
    onData() {}
    onResize() {}
    write() {}
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    scrollToBottom() {}
    registerLinkProvider() {
      return { dispose() {} };
    }
  },
}));
vi.mock("xterm-addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("xterm-addon-search", () => ({
  SearchAddon: class {
    activate() {}
    dispose() {}
    findNext() {}
    findPrevious() {}
    clearDecorations() {}
  },
}));
vi.mock("xterm/css/xterm.css", () => ({}));

vi.mock("@/ipc/client", () => ({
  launchAgent: vi.fn(),
  attachAgent: vi.fn(),
  agentWrite: vi.fn(async () => {}),
  agentResize: vi.fn(async () => {}),
  killAgent: vi.fn(async () => {}),
  listAgentsForWorktree: vi.fn(async () => []),
}));

import * as client from "@/ipc/client";
import { AgentLeafSlot } from "./AgentPane";
import {
  getAgentLeafStates,
  clearAgentLeafStatesForWorktree,
  type AgentLeafState,
} from "./agent-leaf-state";
import type { AgentBackendKind, WorktreeId } from "@/ipc/types";

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom doesn't ship ResizeObserver, but createAgentLeafState
  // constructs one to keep xterm fitted. Stub a no-op implementation.
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
});

describe("AgentLeafSlot pool behavior", () => {
  it("StrictMode double-mount launches the agent only once (pool dedupes)", async () => {
    // Pre-pool, the launch effect ran twice under StrictMode and we
    // had to kill the first session as an orphan. Now the pool absorbs
    // the mount/unmount/remount cycle: state is created on the first
    // mount, host is detached on cleanup but stays in the pool, and
    // the second mount reattaches the same state — so launchAgent is
    // hit once and no killAgent fires.
    const worktreeId = "w-strictmode" as WorktreeId;
    clearAgentLeafStatesForWorktree(worktreeId);

    let nextId = 1;
    (client.launchAgent as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        await Promise.resolve();
        return {
          id: `session-${nextId++}`,
          backend: "claudeCode" as AgentBackendKind,
          argv: ["claude"],
        };
      },
    );

    const leafStates = getAgentLeafStates(worktreeId);
    render(
      <StrictMode>
        <AgentLeafSlot
          worktreeId={worktreeId}
          mode={{ kind: "launch", backend: "claudeCode" }}
          poolKey="tab-1"
          visible={true}
          leafStates={leafStates}
          onSession={() => {}}
        />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(client.launchAgent).toHaveBeenCalledTimes(1);
    });
    expect(client.killAgent).not.toHaveBeenCalled();

    clearAgentLeafStatesForWorktree(worktreeId);
  });

  it("kills the orphan when the slot is disposed mid-launch", async () => {
    // If the user explicitly closes the tab (which calls
    // disposeAgentLeafState) while launchAgent is still in flight, the
    // session is still spawning on the Rust side. The post-resolve
    // path kills it so it doesn't reappear as a phantom adopted tab.
    const worktreeId = "w-orphan" as WorktreeId;
    clearAgentLeafStatesForWorktree(worktreeId);

    let resolveLaunch: (v: unknown) => void = () => {};
    (client.launchAgent as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<unknown>((res) => {
          resolveLaunch = res;
        }),
    );

    const leafStates = getAgentLeafStates(worktreeId);
    render(
      <AgentLeafSlot
        worktreeId={worktreeId}
        mode={{ kind: "launch", backend: "claudeCode" }}
        poolKey="tab-1"
        visible={true}
        leafStates={leafStates}
        onSession={() => {}}
      />,
    );

    // Simulate explicit close before the launch resolves.
    const state = leafStates.get("tab-1") as AgentLeafState;
    expect(state).toBeDefined();
    const { disposeAgentLeafState } = await import("./agent-leaf-state");
    disposeAgentLeafState(state);

    // Now resolve the in-flight launch — the post-resolve path should
    // see `killed === true` and kill the orphan.
    resolveLaunch({
      id: "orphan-session",
      backend: "claudeCode" as AgentBackendKind,
      argv: ["claude"],
    });

    await waitFor(() => {
      expect(client.killAgent).toHaveBeenCalledWith("orphan-session");
    });

    clearAgentLeafStatesForWorktree(worktreeId);
  });
});
