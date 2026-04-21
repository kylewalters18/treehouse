import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useToastsStore, toastError, toastInfo, toastSuccess } from "./toasts";

describe("toasts store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Start each test with an empty stack.
    const { toasts, dismiss } = useToastsStore.getState();
    for (const t of toasts) dismiss(t.id);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("push assigns an id and appends to the stack", () => {
    useToastsStore.getState().push({ kind: "info", title: "a" });
    useToastsStore.getState().push({ kind: "info", title: "b" });
    const toasts = useToastsStore.getState().toasts;
    expect(toasts.length).toBe(2);
    expect(toasts[0].title).toBe("a");
    expect(toasts[1].title).toBe("b");
    expect(toasts[0].id).not.toBe(toasts[1].id);
  });

  it("dismiss removes just that toast", () => {
    useToastsStore.getState().push({ kind: "error", title: "x" });
    useToastsStore.getState().push({ kind: "error", title: "y" });
    const ids = useToastsStore.getState().toasts.map((t) => t.id);
    useToastsStore.getState().dismiss(ids[0]);
    const remaining = useToastsStore.getState().toasts;
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(ids[1]);
  });

  it("auto-dismisses after ~6 seconds", () => {
    toastInfo("self-cleaning");
    expect(useToastsStore.getState().toasts.length).toBe(1);
    vi.advanceTimersByTime(6_000);
    expect(useToastsStore.getState().toasts.length).toBe(0);
  });

  it("helper functions tag the correct kind", () => {
    toastError("e");
    toastInfo("i");
    toastSuccess("s");
    const kinds = useToastsStore.getState().toasts.map((t) => t.kind).sort();
    expect(kinds).toEqual(["error", "info", "success"]);
  });
});
