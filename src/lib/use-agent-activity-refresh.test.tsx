import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

let fire: (() => void) | null = null;
const unlisten = vi.fn();
vi.mock("@/ipc/client", () => ({
  onAgentActivityChanged: vi.fn(async (cb: () => void) => {
    fire = cb;
    return unlisten;
  }),
}));

import { useAgentActivityRefresh } from "./use-agent-activity-refresh";

function Probe({ refresh, enabled = true }: { refresh: () => void; enabled?: boolean }) {
  useAgentActivityRefresh(refresh, 5000, enabled);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  fire = null;
  unlisten.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("useAgentActivityRefresh", () => {
  it("refreshes on mount, on each pushed change, and on the fallback poll", async () => {
    const refresh = vi.fn();
    const { unmount } = render(<Probe refresh={refresh} />);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fire).not.toBeNull());
    fire!();
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);
    expect(refresh).toHaveBeenCalledTimes(3);
    unmount();
    expect(unlisten).toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("does nothing while disabled", () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} enabled={false} />);
    vi.advanceTimersByTime(10_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
