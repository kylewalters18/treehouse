import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { LspConfig, WorktreeId } from "@/ipc/types";
import { asMessage } from "@/lib/errors";

/// Single-line summary of whatever a language server is currently doing
/// (indexing, type-checking, loading crates, etc.). Surfaced from the
/// LSP `$/progress` stream by `session.ts`.
export type SessionProgress = {
  title: string;
  message?: string;
  percentage?: number;
};

type LspState = {
  configs: LspConfig[];
  /// Resolved command paths — `null` means we checked and it's not on PATH.
  /// Keyed by `LspConfig.command`. Lazily populated by `refreshResolution`.
  resolved: Record<string, string | null>;
  loading: boolean;
  error: string | null;
  /// Toast deduping: keep track of which (worktreeId, languageId) pairs
  /// we've already nagged about a missing binary, so re-opening files in
  /// the same worktree doesn't spam toasts.
  notFoundNotified: Set<string>;
  /// Active progress per `${worktreeId}::${languageId}`. Nulled out when
  /// the server reports `end` for its last token or the session disposes.
  progress: Record<string, SessionProgress | null>;
  /// Bumped by the "Restart language servers" command so
  /// `useLspIntegration` re-runs and reopens the active file in a
  /// fresh session. Disposing the session alone doesn't trigger a
  /// re-open because none of the effect's React deps changed —
  /// flipping the toggle in Settings works because that mutates
  /// `configs`, which IS a dep.
  restartEpoch: Record<WorktreeId, number>;
  /// IDs of the code-seeded built-in languages. Used by Settings to
  /// distinguish a built-in row (which "Reset"s to its default) from a
  /// purely custom one (which "Delete"s).
  builtinIds: string[];
  /// IDs that currently have a `[[lsp.language]]` entry in
  /// `treehouse.toml` — customized built-ins plus all custom languages.
  customizedIds: string[];

  load: () => Promise<void>;
  refreshResolution: () => Promise<void>;
  /// Persist a language config to `treehouse.toml` and refresh state.
  upsertLanguage: (config: LspConfig) => Promise<void>;
  /// Drop a language's `treehouse.toml` entry (reset built-in / delete
  /// custom) and refresh state.
  resetLanguage: (languageId: string) => Promise<void>;
  markNotFoundNotified: (worktreeId: string, languageId: string) => void;
  hasNotifiedNotFound: (worktreeId: string, languageId: string) => boolean;
  setProgress: (
    worktreeId: string,
    languageId: string,
    progress: SessionProgress | null,
  ) => void;
  bumpRestartEpoch: (worktreeId: WorktreeId) => void;
};

export const useLspStore = create<LspState>((set, get) => ({
  configs: [],
  resolved: {},
  loading: false,
  error: null,
  notFoundNotified: new Set(),
  progress: {},
  restartEpoch: {},
  builtinIds: [],
  customizedIds: [],

  async load() {
    set({ loading: true, error: null });
    try {
      const [configs, builtinIds, customizedIds] = await Promise.all([
        ipc.lspListConfigs(),
        ipc.lspBuiltinIds(),
        ipc.lspCustomizedIds(),
      ]);
      set({ configs, builtinIds, customizedIds, loading: false });
      void get().refreshResolution();
    } catch (e) {
      set({ error: asMessage(e), loading: false });
    }
  },

  async upsertLanguage(config) {
    const configs = await ipc.lspUpsertLanguage(config);
    const customizedIds = await ipc.lspCustomizedIds();
    set({ configs, customizedIds });
    void get().refreshResolution();
  },

  async resetLanguage(languageId) {
    const configs = await ipc.lspResetLanguage(languageId);
    const customizedIds = await ipc.lspCustomizedIds();
    set({ configs, customizedIds });
    void get().refreshResolution();
  },

  async refreshResolution() {
    const { configs } = get();
    const unique = Array.from(new Set(configs.map((c) => c.command)));
    const entries = await Promise.all(
      unique.map(async (cmd) => {
        try {
          return [cmd, await ipc.lspResolveCommand(cmd)] as const;
        } catch {
          return [cmd, null] as const;
        }
      }),
    );
    set({ resolved: Object.fromEntries(entries) });
  },

  markNotFoundNotified(worktreeId, languageId) {
    const key = `${worktreeId}::${languageId}`;
    const next = new Set(get().notFoundNotified);
    next.add(key);
    set({ notFoundNotified: next });
  },

  hasNotifiedNotFound(worktreeId, languageId) {
    return get().notFoundNotified.has(`${worktreeId}::${languageId}`);
  },

  setProgress(worktreeId, languageId, progress) {
    const key = `${worktreeId}::${languageId}`;
    set((s) => ({ progress: { ...s.progress, [key]: progress } }));
  },

  bumpRestartEpoch(worktreeId) {
    set((s) => ({
      restartEpoch: {
        ...s.restartEpoch,
        [worktreeId]: (s.restartEpoch[worktreeId] ?? 0) + 1,
      },
    }));
  },
}));
