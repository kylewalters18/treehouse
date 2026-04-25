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
  },
}));
vi.mock("xterm-addon-fit", () => ({
  FitAddon: class {
    fit() {}
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
import { AgentInstance } from "./AgentPane";
import type { AgentBackendKind, WorktreeId } from "@/ipc/types";

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom doesn't ship ResizeObserver, but AgentInstance constructs one
  // to keep xterm fitted. Stub a no-op implementation.
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
});

describe("AgentInstance launch lifecycle", () => {
  it("kills the orphan session created by the discarded first mount", async () => {
    // Reproduces: create an agent, navigate away, navigate back — under
    // React StrictMode the launch effect runs twice (mount → cleanup →
    // mount) and each run spawns a session. Without the orphan-kill,
    // the first-mount session lingers and shows up as a duplicate tab
    // on the next adopt pass.
    let nextId = 1;
    (client.launchAgent as ReturnType<typeof vi.fn>).mockImplementation(
      // Async tick before resolving so cleanup of the first mount fires
      // while launchAgent is still in flight — the path the bug lives on.
      async () => {
        await Promise.resolve();
        return {
          id: `session-${nextId++}`,
          backend: "claudeCode" as AgentBackendKind,
          argv: ["claude"],
        };
      },
    );

    render(
      <StrictMode>
        <AgentInstance
          worktreeId={"w1" as WorktreeId}
          mode={{ kind: "launch", backend: "claudeCode" }}
          visible={true}
          onSession={() => {}}
        />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(client.launchAgent).toHaveBeenCalledTimes(2);
      expect(client.killAgent).toHaveBeenCalledTimes(1);
    });
    // The orphan is whichever session id resolved while the first mount
    // was already disposed — it's the first one queued by the mock.
    expect(client.killAgent).toHaveBeenCalledWith("session-1");
  });
});
