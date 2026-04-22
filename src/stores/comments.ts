import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { Comment } from "@/ipc/types";
import { asMessage } from "@/lib/errors";
import { toastError } from "@/stores/toasts";

/// Comments are persisted as a flat list across all workspaces. We key into
/// the persisted store by `(workspaceRoot, branch)` because worktree IDs are
/// regenerated on every app restart. Filters happen at read time.
type CommentsState = {
  /// Loaded once on app startup; in-memory copy is the source of truth.
  /// Mutations write the full list back via save_comments.
  items: Comment[];
  /// Comment IDs queued for batch send. Ephemeral — not persisted; cleared
  /// when a queued comment is sent or resolved.
  queue: Set<string>;
  loaded: boolean;
  load: () => Promise<void>;
  add: (
    fields: Pick<Comment, "workspaceRoot" | "branch" | "filePath" | "line" | "text">,
  ) => Promise<Comment | null>;
  updateText: (id: string, text: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  resolve: (id: string) => Promise<void>;
  unresolve: (id: string) => Promise<void>;
  toggleQueue: (id: string) => void;
  clearQueueForBranch: (workspaceRoot: string, branch: string) => void;
};

function nowMs(): number {
  return Date.now();
}

function newId(): string {
  return crypto.randomUUID();
}

async function persist(items: Comment[]): Promise<Comment[]> {
  return await ipc.saveComments(items);
}

export const useCommentsStore = create<CommentsState>((set, get) => ({
  items: [],
  queue: new Set(),
  loaded: false,
  async load() {
    try {
      const items = await ipc.listComments();
      set({ items, loaded: true });
    } catch (e) {
      toastError("Failed to load comments", asMessage(e));
      set({ loaded: true });
    }
  },
  async add(fields) {
    const c: Comment = {
      id: newId(),
      workspaceRoot: fields.workspaceRoot,
      branch: fields.branch,
      filePath: fields.filePath,
      line: fields.line,
      text: fields.text,
      createdAt: nowMs(),
      resolvedAt: null,
    };
    const next = [...get().items, c];
    try {
      const saved = await persist(next);
      set({ items: saved });
      return c;
    } catch (e) {
      toastError("Couldn't save comment", asMessage(e));
      return null;
    }
  },
  async updateText(id, text) {
    const next = get().items.map((c) => (c.id === id ? { ...c, text } : c));
    try {
      const saved = await persist(next);
      set({ items: saved });
    } catch (e) {
      toastError("Couldn't update comment", asMessage(e));
    }
  },
  async remove(id) {
    const next = get().items.filter((c) => c.id !== id);
    try {
      const saved = await persist(next);
      set({ items: saved });
      // Drop from queue if present.
      const q = new Set(get().queue);
      if (q.delete(id)) set({ queue: q });
    } catch (e) {
      toastError("Couldn't delete comment", asMessage(e));
    }
  },
  async resolve(id) {
    const ts = nowMs();
    const next = get().items.map((c) =>
      c.id === id ? { ...c, resolvedAt: ts } : c,
    );
    try {
      const saved = await persist(next);
      set({ items: saved });
      // Resolving pulls the comment out of the queue.
      const q = new Set(get().queue);
      if (q.delete(id)) set({ queue: q });
    } catch (e) {
      toastError("Couldn't resolve comment", asMessage(e));
    }
  },
  async unresolve(id) {
    const next = get().items.map((c) =>
      c.id === id ? { ...c, resolvedAt: null } : c,
    );
    try {
      const saved = await persist(next);
      set({ items: saved });
    } catch (e) {
      toastError("Couldn't reopen comment", asMessage(e));
    }
  },
  toggleQueue(id) {
    const q = new Set(get().queue);
    if (q.has(id)) q.delete(id);
    else q.add(id);
    set({ queue: q });
  },
  clearQueueForBranch(workspaceRoot, branch) {
    const items = get().items;
    const q = new Set(get().queue);
    for (const id of [...q]) {
      const c = items.find((x) => x.id === id);
      if (c && c.workspaceRoot === workspaceRoot && c.branch === branch) {
        q.delete(id);
      }
    }
    set({ queue: q });
  },
}));

/// Format a comment's payload for sending to an agent over its stdin.
/// Matches the pattern the user OK'd:
///
///     Review comment on <path>:<line>
///
///     <text>
export function formatCommentForAgent(c: Comment): string {
  return `Review comment on ${c.filePath}:${c.line}\n\n${c.text}\n`;
}

/// Format a batch of comments as one structured message — a short header
/// listing the count, then each comment block separated by horizontal
/// rules. Sent as a single write to the agent's stdin.
export function formatBatchForAgent(cs: Comment[]): string {
  const header = `Review comments (${cs.length}):\n`;
  const blocks = cs
    .map((c) => `[${c.filePath}:${c.line}]\n${c.text}`)
    .join("\n\n---\n\n");
  return `${header}\n${blocks}\n`;
}
