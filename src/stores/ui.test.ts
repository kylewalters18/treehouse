import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./ui";

describe("ui store", () => {
  beforeEach(() => {
    useUiStore.getState().reset();
  });

  it("tracks the selected worktree", () => {
    useUiStore.getState().selectWorktree("wt-1");
    expect(useUiStore.getState().selectedWorktreeId).toBe("wt-1");
    useUiStore.getState().selectWorktree(null);
    expect(useUiStore.getState().selectedWorktreeId).toBe(null);
  });

  it("toggles focus mode", () => {
    expect(useUiStore.getState().focusMode).toBe(false);
    useUiStore.getState().toggleFocusMode();
    expect(useUiStore.getState().focusMode).toBe(true);
    useUiStore.getState().toggleFocusMode();
    expect(useUiStore.getState().focusMode).toBe(false);
  });

  it("setFocusMode accepts explicit values", () => {
    useUiStore.getState().setFocusMode(true);
    expect(useUiStore.getState().focusMode).toBe(true);
    useUiStore.getState().setFocusMode(false);
    expect(useUiStore.getState().focusMode).toBe(false);
  });

  it("toggles worktree sidebar independently of focus mode", () => {
    expect(useUiStore.getState().worktreeSidebarCollapsed).toBe(false);
    useUiStore.getState().toggleWorktreeSidebar();
    expect(useUiStore.getState().worktreeSidebarCollapsed).toBe(true);
    useUiStore.getState().toggleFocusMode();
    // Toggling focus does NOT touch the collapse state.
    expect(useUiStore.getState().worktreeSidebarCollapsed).toBe(true);
  });

  it("pending agent launch is one-shot and per worktree", () => {
    const s = useUiStore.getState();
    s.requestAgentLaunchFor("wt-1");
    expect(s.consumePendingAgentLaunch("wt-2")).toBe(false);
    expect(s.consumePendingAgentLaunch("wt-1")).toBe(true);
    expect(s.consumePendingAgentLaunch("wt-1")).toBe(false);
  });

  it("stamps an agent as seen when it becomes, or stops being, visible", () => {
    const s = useUiStore.getState();
    s.setActiveAgent("wt-1", "a-1");
    expect(useUiStore.getState().agentSeenAt["a-1"]).toBeUndefined();
    s.selectWorktree("wt-1");
    const first = useUiStore.getState().agentSeenAt["a-1"];
    expect(first).toBeGreaterThan(0);
    s.setActiveAgent("wt-1", "a-2");
    expect(useUiStore.getState().agentSeenAt["a-1"]).toBeGreaterThanOrEqual(first);
    expect(useUiStore.getState().agentSeenAt["a-2"]).toBeGreaterThan(0);
  });

  it("focusAgent selects the worktree, sets its tab, and bumps the request", () => {
    const s = useUiStore.getState();
    s.focusAgent("wt-2", "a-9");
    const after = useUiStore.getState();
    expect(after.selectedWorktreeId).toBe("wt-2");
    expect(after.activeAgentByWorktree["wt-2"]).toBe("a-9");
    expect(after.agentFocusRequest).toEqual({ agentId: "a-9", nonce: 1 });
    s.focusAgent("wt-2", "a-9");
    expect(useUiStore.getState().agentFocusRequest?.nonce).toBe(2);
  });

  it("opening the board marks the visible agent seen", () => {
    const s = useUiStore.getState();
    s.focusAgent("wt-1", "a-1");
    useUiStore.setState({ agentSeenAt: {} });
    s.setAgentBoardOpen(true);
    expect(useUiStore.getState().agentBoardOpen).toBe(true);
    expect(useUiStore.getState().agentSeenAt["a-1"]).toBeGreaterThan(0);
  });

  it("reset wipes everything back to defaults", () => {
    const s = useUiStore.getState();
    s.selectWorktree("x");
    s.setFocusMode(true);
    s.toggleWorktreeSidebar();
    s.reset();
    const after = useUiStore.getState();
    expect(after.selectedWorktreeId).toBe(null);
    expect(after.focusMode).toBe(false);
    expect(after.worktreeSidebarCollapsed).toBe(false);
  });
});
