import { describe, it, expect, vi, beforeEach } from "vitest";

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
    scrollToBottom() {}
    attachCustomKeyEventHandler() {}
    registerLinkProvider() {
      return { dispose() {} };
    }
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
vi.mock("xterm-addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("xterm/css/xterm.css", () => ({}));

vi.mock("@/ipc/client", () => ({
  openTerminal: vi.fn(),
  attachTerminal: vi.fn(),
  ptyWrite: vi.fn(async () => {}),
  ptyResize: vi.fn(async () => {}),
  closeTerminal: vi.fn(async () => {}),
  listTerminalsForWorktree: vi.fn(async () => []),
}));

import * as client from "@/ipc/client";
import { createLeafState, disposeLeafState } from "./TerminalPane";
import { makeLeaf } from "./pane-tree";
import type { WorktreeId } from "@/ipc/types";

beforeEach(() => {
  vi.clearAllMocks();
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
});

describe("LeafState lifecycle", () => {
  it("kills the orphan PTY when disposed before openTerminal resolves", async () => {
    // Reproduces the worktree-switch-mid-spawn race that surfaced as
    // duplicate tabs after navigating away. createLeafState's async
    // path must close the just-spawned PTY when the leaf is killed
    // before the IPC returned, otherwise the orphan would reappear on
    // the next reconcile.
    let resolveOpen: (s: unknown) => void = () => {};
    (client.openTerminal as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((res) => {
          resolveOpen = (s) => res(s);
        }),
    );

    const state = createLeafState(
      "w1" as WorktreeId,
      makeLeaf({ kind: "open" }),
      () => {},
    );

    // User unmounts the pane (worktree switch / pane close) before the
    // PTY came back. dispose flips killed=true synchronously.
    disposeLeafState(state);

    // Now the IPC resolves with a real session.
    resolveOpen({
      id: "term-1",
      worktreeId: "w1",
      shell: "zsh",
      cols: 80,
      rows: 24,
      alive: true,
    });

    // Yield until the async block runs its post-await branch.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // No double-kill: dispose's `if (state.sessionId)` is false because
    // the async path bailed before assigning sessionId. The orphan-kill
    // inside the async path is the only closeTerminal call.
    expect(client.closeTerminal).toHaveBeenCalledTimes(1);
    expect(client.closeTerminal).toHaveBeenCalledWith("term-1");
  });
});
