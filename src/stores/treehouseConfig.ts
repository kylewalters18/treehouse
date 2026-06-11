import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type {
  AgentBackendKind,
  AgentPatterns,
  BackendPatterns,
  LspOverride,
  WorktreeHookEntry,
} from "@/ipc/types";
import { asMessage } from "@/lib/errors";

/// Renderer mirror of the hand-editable sections of `treehouse.toml`
/// that the Settings UI now surfaces: per-workspace LSP overrides,
/// worktree lifecycle hooks, and per-backend agent status patterns.
/// The Rust side owns the file; these are cached snapshots refreshed
/// after each write (which returns the persisted state).
///
/// Distinct from `useLspStore`, which owns the merged language list +
/// runtime resolution. Overrides/hooks/patterns are pure config with
/// no runtime resolution, so they live here.
type TreehouseConfigState = {
  overrides: LspOverride[];
  onCreate: WorktreeHookEntry[];
  onDestroy: WorktreeHookEntry[];
  /// Effective patterns: built-in defaults filled in for any backend
  /// the user hasn't customized. `null` until first load.
  patterns: AgentPatterns | null;
  /// Backend keys (`claudeCode` / `kiro` / `codex`) with an explicit
  /// section on disk — gates the per-backend "Reset to default".
  customizedBackends: string[];
  loaded: boolean;
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  saveOverrides: (overrides: LspOverride[]) => Promise<void>;
  saveHooks: (
    onCreate: WorktreeHookEntry[],
    onDestroy: WorktreeHookEntry[],
  ) => Promise<void>;
  saveBackendPatterns: (
    backend: AgentBackendKind,
    patterns: BackendPatterns,
  ) => Promise<void>;
  resetBackend: (backend: AgentBackendKind) => Promise<void>;
};

export const useTreehouseConfigStore = create<TreehouseConfigState>(
  (set) => ({
    overrides: [],
    onCreate: [],
    onDestroy: [],
    patterns: null,
    customizedBackends: [],
    loaded: false,
    loading: false,
    error: null,

    async load() {
      set({ loading: true, error: null });
      try {
        const [overrides, hooks, view] = await Promise.all([
          ipc.lspOverridesGet(),
          ipc.worktreeHooksGet(),
          ipc.agentPatternsGet(),
        ]);
        set({
          overrides,
          onCreate: hooks.onCreate,
          onDestroy: hooks.onDestroy,
          patterns: view.patterns,
          customizedBackends: view.customized,
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

    async saveBackendPatterns(backend, patterns) {
      const view = await ipc.agentPatternsSet(backend, patterns);
      set({ patterns: view.patterns, customizedBackends: view.customized });
    },

    async resetBackend(backend) {
      const view = await ipc.agentPatternsReset(backend);
      set({ patterns: view.patterns, customizedBackends: view.customized });
    },
  }),
);
