import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type {
  LspOverride,
  WorktreeHookEntry,
} from "@/ipc/types";
import { asMessage } from "@/lib/errors";

/// Renderer mirror of the hand-editable sections of `treehouse.toml`
/// that the Settings UI now surfaces: per-workspace LSP overrides,
/// and worktree lifecycle hooks.
/// The Rust side owns the file; these are cached snapshots refreshed
/// after each write (which returns the persisted state).
///
/// Distinct from `useLspStore`, which owns the merged language list +
/// runtime resolution. Overrides and hooks are pure config with
/// no runtime resolution, so they live here.
type TreehouseConfigState = {
  overrides: LspOverride[];
  onCreate: WorktreeHookEntry[];
  onDestroy: WorktreeHookEntry[];
  loaded: boolean;
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  saveOverrides: (overrides: LspOverride[]) => Promise<void>;
  saveHooks: (
    onCreate: WorktreeHookEntry[],
    onDestroy: WorktreeHookEntry[],
  ) => Promise<void>;
};

export const useTreehouseConfigStore = create<TreehouseConfigState>(
  (set) => ({
    overrides: [],
    onCreate: [],
    onDestroy: [],
    loaded: false,
    loading: false,
    error: null,

    async load() {
      set({ loading: true, error: null });
      try {
        const [overrides, hooks] = await Promise.all([
          ipc.lspOverridesGet(),
          ipc.worktreeHooksGet(),
        ]);
        set({
          overrides,
          onCreate: hooks.onCreate,
          onDestroy: hooks.onDestroy,
          loaded: true,
          loading: false,
        });
      } catch (e) {
        set({ error: asMessage(e), loading: false });
      }
    },

    async saveOverrides(overrides) {
      const saved = await ipc.lspOverridesSet(overrides);
      set({ overrides: saved });
    },

    async saveHooks(onCreate, onDestroy) {
      const saved = await ipc.worktreeHooksSet(onCreate, onDestroy);
      set({ onCreate: saved.onCreate, onDestroy: saved.onDestroy });
    },
  }),
);
