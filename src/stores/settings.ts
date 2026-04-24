import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type {
  AgentBackendKind,
  MergeBackStrategy,
  Settings,
  SyncStrategy,
} from "@/ipc/types";

type SettingsState = {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  setSyncStrategy: (s: SyncStrategy) => Promise<void>;
  setMergeBackStrategy: (s: MergeBackStrategy) => Promise<void>;
  setInitSubmodules: (on: boolean) => Promise<void>;
  setDefaultAgentBackend: (b: AgentBackendKind) => Promise<void>;
};

const DEFAULT_SETTINGS: Settings = {
  syncStrategy: "rebase",
  mergeBackStrategy: "rebaseFf",
  initSubmodules: false,
  defaultAgentBackend: "claudeCode",
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  async load() {
    try {
      const s = await ipc.getSettings();
      set({ settings: s, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async setSyncStrategy(s) {
    const next: Settings = { ...get().settings, syncStrategy: s };
    set({ settings: next });
    try {
      await ipc.updateSettings(next);
    } catch {
      // best effort — UI keeps the new value even if disk write hiccupped
    }
  },
  async setMergeBackStrategy(s) {
    const next: Settings = { ...get().settings, mergeBackStrategy: s };
    set({ settings: next });
    try {
      await ipc.updateSettings(next);
    } catch {}
  },
  async setInitSubmodules(on) {
    const next: Settings = { ...get().settings, initSubmodules: on };
    set({ settings: next });
    try {
      await ipc.updateSettings(next);
    } catch {}
  },
  async setDefaultAgentBackend(b) {
    const next: Settings = { ...get().settings, defaultAgentBackend: b };
    set({ settings: next });
    try {
      await ipc.updateSettings(next);
    } catch {}
  },
}));
