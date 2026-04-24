import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ipc from "@/ipc/client";
import { useSettingsStore } from "./settings";

vi.mock("@/ipc/client");
const ipcMocked = vi.mocked(ipc);

function freshState() {
  useSettingsStore.setState({
    settings: {
      syncStrategy: "rebase",
      mergeBackStrategy: "rebaseFf",
      initSubmodules: false,
      defaultAgentBackend: "claudeCode",
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
      initSubmodules: true,
      defaultAgentBackend: "kiro",
    });
    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.settings.syncStrategy).toBe("merge");
    expect(s.settings.mergeBackStrategy).toBe("squash");
    expect(s.settings.initSubmodules).toBe(true);
  });

  it("load tolerates backend failure and keeps defaults", async () => {
    ipcMocked.getSettings.mockRejectedValueOnce(new Error("disk"));
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().loaded).toBe(true);
    // Pre-test defaults untouched.
    expect(useSettingsStore.getState().settings.syncStrategy).toBe("rebase");
  });

  it("setSyncStrategy updates state and writes to backend", async () => {
    ipcMocked.updateSettings.mockResolvedValueOnce({
      syncStrategy: "merge",
      mergeBackStrategy: "rebaseFf",
      initSubmodules: false,
      defaultAgentBackend: "claudeCode",
    });
    await useSettingsStore.getState().setSyncStrategy("merge");
    expect(useSettingsStore.getState().settings.syncStrategy).toBe("merge");
    expect(ipcMocked.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ syncStrategy: "merge" }),
    );
  });

  it("setInitSubmodules updates state and writes to backend", async () => {
    ipcMocked.updateSettings.mockResolvedValueOnce({
      syncStrategy: "rebase",
      mergeBackStrategy: "rebaseFf",
      initSubmodules: true,
      defaultAgentBackend: "claudeCode",
    });
    await useSettingsStore.getState().setInitSubmodules(true);
    expect(useSettingsStore.getState().settings.initSubmodules).toBe(true);
    expect(ipcMocked.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ initSubmodules: true }),
    );
  });

  it("setDefaultAgentBackend updates state and writes to backend", async () => {
    ipcMocked.updateSettings.mockResolvedValueOnce({
      syncStrategy: "rebase",
      mergeBackStrategy: "rebaseFf",
      initSubmodules: false,
      defaultAgentBackend: "kiro",
    });
    await useSettingsStore.getState().setDefaultAgentBackend("kiro");
    expect(useSettingsStore.getState().settings.defaultAgentBackend).toBe("kiro");
    expect(ipcMocked.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ defaultAgentBackend: "kiro" }),
    );
  });
});
