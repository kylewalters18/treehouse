import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ipc from "@/ipc/client";
import { useSettingsStore, ZOOM_MAX, ZOOM_MIN } from "./settings";

vi.mock("@/ipc/client");
const ipcMocked = vi.mocked(ipc);

function freshState() {
  useSettingsStore.setState({
    settings: {
      syncStrategy: "rebase",
      mergeBackStrategy: "rebaseFf",
      zoom: 1.0,
    },
    loaded: false,
  });
}

describe("settings store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    freshState();
  });

  it("load fetches from the backend and marks loaded", async () => {
    ipcMocked.getSettings.mockResolvedValueOnce({
      syncStrategy: "merge",
      mergeBackStrategy: "squash",
      zoom: 1.25,
    });
    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.settings.syncStrategy).toBe("merge");
    expect(s.settings.zoom).toBe(1.25);
  });

  it("load tolerates backend failure and keeps defaults", async () => {
    ipcMocked.getSettings.mockRejectedValueOnce(new Error("disk"));
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().loaded).toBe(true);
    // Pre-test defaults untouched.
    expect(useSettingsStore.getState().settings.zoom).toBe(1.0);
  });

  it("setSyncStrategy updates state and writes to backend", async () => {
    ipcMocked.updateSettings.mockResolvedValueOnce({
      syncStrategy: "merge",
      mergeBackStrategy: "rebaseFf",
      zoom: 1.0,
    });
    await useSettingsStore.getState().setSyncStrategy("merge");
    expect(useSettingsStore.getState().settings.syncStrategy).toBe("merge");
    expect(ipcMocked.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ syncStrategy: "merge" }),
    );
  });

  it("setZoom clamps out-of-range values", async () => {
    ipcMocked.updateSettings.mockResolvedValue({
      syncStrategy: "rebase",
      mergeBackStrategy: "rebaseFf",
      zoom: 1.0,
    });
    await useSettingsStore.getState().setZoom(10);
    expect(useSettingsStore.getState().settings.zoom).toBe(ZOOM_MAX);
    await useSettingsStore.getState().setZoom(0.1);
    expect(useSettingsStore.getState().settings.zoom).toBe(ZOOM_MIN);
  });

  it("adjustZoom is additive and respects bounds", async () => {
    ipcMocked.updateSettings.mockResolvedValue({
      syncStrategy: "rebase",
      mergeBackStrategy: "rebaseFf",
      zoom: 1.0,
    });
    await useSettingsStore.getState().adjustZoom(0.1);
    expect(useSettingsStore.getState().settings.zoom).toBeCloseTo(1.1);
    // Crank to upper bound.
    for (let i = 0; i < 20; i++) {
      await useSettingsStore.getState().adjustZoom(0.1);
    }
    expect(useSettingsStore.getState().settings.zoom).toBe(ZOOM_MAX);
  });

  it("resetZoom returns to 1.0", async () => {
    ipcMocked.updateSettings.mockResolvedValue({
      syncStrategy: "rebase",
      mergeBackStrategy: "rebaseFf",
      zoom: 1.5,
    });
    await useSettingsStore.getState().setZoom(1.5);
    await useSettingsStore.getState().resetZoom();
    expect(useSettingsStore.getState().settings.zoom).toBe(1.0);
  });
});
