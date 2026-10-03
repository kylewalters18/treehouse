import { create } from "zustand";
import * as ipc from "@/ipc/client";
import { asMessage } from "@/lib/errors";
import { toastError } from "@/stores/toasts";

/// Worktree → forge issue links, by worktree path (IDs aren't stable across
/// restarts; paths survive branch renames). Set explicitly when creating
/// from an issue or via "Link issue" — never parsed from the branch name.
/// Rust persists the map; this mirrors it.
type IssueLinksState = {
  byPath: Record<string, number>;
  /// Load the map and, the first time, follow Rust's change events (links
  /// set by an agent over MCP, or on worktree removal).
  load: () => Promise<void>;
  setLink: (path: string, issue: number | null) => Promise<boolean>;
};

let subscribed = false;

export const useIssueLinksStore = create<IssueLinksState>((set, get) => ({
  byPath: {},
  async load() {
    if (!subscribed) {
      subscribed = true;
      void ipc.onIssueLinksChanged(() => void get().load());
    }
    try {
      set({ byPath: await ipc.listIssueLinks() });
    } catch {
      // Links are a convenience; an unreadable file just means none.
    }
  },
  async setLink(path, issue) {
    const prev = get().byPath;
    const next = { ...prev };
    if (issue == null) delete next[path];
    else next[path] = issue;
    set({ byPath: next });
    try {
      set({ byPath: await ipc.setWorktreeIssue(path, issue) });
      return true;
    } catch (e) {
      set({ byPath: prev });
      toastError(issue == null ? "Couldn't unlink issue" : "Couldn't link issue", asMessage(e));
      return false;
    }
  },
}));
