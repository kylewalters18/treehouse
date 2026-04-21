import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { MergeBackStrategy, Settings, SyncStrategy } from "@/ipc/types";

type SettingsState = {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  setSyncStrategy: (s: SyncStrategy) => Promise<void>;
  setMergeBackStrategy: (s: MergeBackStrategy) => Promise<void>;
  setZoom: (zoom: number) => Promise<void>;
  adjustZoom: (delta: number) => Promise<void>;
  resetZoom: () => Promise<void>;
  setInitSubmodules: (on: boolean) => Promise<void>;
};

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;
export const ZOOM_STEP = 0.1;

function clampZoom(z: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
}

const DEFAULT_SETTINGS: Settings = {
  syncStrategy: "rebase",
  mergeBackStrategy: "rebaseFf",
  zoom: 1.0,
  initSubmodules: false,
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
  async setZoom(zoom) {
    const next: Settings = { ...get().settings, zoom: clampZoom(zoom) };
    set({ settings: next });
    try {
      await ipc.updateSettings(next);
    } catch {}
  },
  async adjustZoom(delta) {
    await get().setZoom(get().settings.zoom + delta);
  },
  async resetZoom() {
    await get().setZoom(1.0);
  },
  async setInitSubmodules(on) {
    const next: Settings = { ...get().settings, initSubmodules: on };
    set({ settings: next });
    try {
      await ipc.updateSettings(next);
    } catch {}
  },
}));
