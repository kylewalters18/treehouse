import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { LspConfig } from "@/ipc/types";
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

  load: () => Promise<void>;
  save: (config: LspConfig) => Promise<void>;
  refreshResolution: () => Promise<void>;
  markNotFoundNotified: (worktreeId: string, languageId: string) => void;
  hasNotifiedNotFound: (worktreeId: string, languageId: string) => boolean;
  setProgress: (
    worktreeId: string,
    languageId: string,
    progress: SessionProgress | null,
  ) => void;
};

export const useLspStore = create<LspState>((set, get) => ({
  configs: [],
  resolved: {},
  loading: false,
  error: null,
  notFoundNotified: new Set(),
  progress: {},

  async load() {
    set({ loading: true, error: null });
    try {
      const configs = await ipc.lspListConfigs();
      set({ configs, loading: false });
      void get().refreshResolution();
    } catch (e) {
      set({ error: asMessage(e), loading: false });
    }
  },

  async save(config: LspConfig) {
    try {
      const configs = await ipc.lspSaveConfig(config);
      set({ configs });
      void get().refreshResolution();
    } catch (e) {
      set({ error: asMessage(e) });
    }
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
}));
