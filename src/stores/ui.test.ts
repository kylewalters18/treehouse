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
