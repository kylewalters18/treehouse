import { create } from "zustand";
import * as ipc from "@/ipc/client";
import { asMessage } from "@/lib/errors";
import { toastError } from "@/stores/toasts";

/// Worktrees pinned to the top of the sidebar, by path (IDs aren't stable
/// across restarts). Rust persists the list; this mirrors it.
type PinsState = {
  paths: string[];
  load: () => Promise<void>;
  setPinned: (path: string, pinned: boolean) => Promise<void>;
  /// Local-only drop, for a worktree whose removal already unpinned it.
  forget: (path: string) => void;
};

export const usePinsStore = create<PinsState>((set, get) => ({
  paths: [],
  async load() {
    try {
      set({ paths: await ipc.listPinnedWorktrees() });
    } catch {
      // Pins are a convenience; an unreadable file just means none.
    }
  },
  async setPinned(path, pinned) {
    const prev = get().paths;
    // Optimistic so the row moves on click, not after the disk write.
    set({
      paths: pinned
        ? prev.includes(path) ? prev : [...prev, path]
        : prev.filter((p) => p !== path),
    });
    try {
      set({ paths: await ipc.setWorktreePinned(path, pinned) });
    } catch (e) {
      set({ paths: prev });
      toastError(pinned ? "Pin failed" : "Unpin failed", asMessage(e));
    }
  },
  forget(path) {
    const prev = get().paths;
    if (prev.includes(path)) set({ paths: prev.filter((p) => p !== path) });
  },
}));
