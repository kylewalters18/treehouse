import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type { Comment } from "@/ipc/types";
import { asMessage } from "@/lib/errors";
import { toastError } from "@/stores/toasts";

// Comments are persisted as a flat list across all workspaces. We key into
// the persisted store by `(workspaceRoot, branch)` because worktree IDs are
// regenerated on every app restart. Filters happen at read time.

export type CommentStatus = "pending" | "sent" | "resolved";

/// Derived lifecycle: every new comment is pending (part of the next review
/// batch); sending hands it to an agent (sent, awaiting the fix); resolving
/// marks it addressed. Only `resolvedAt` / `sentAt` are persisted.
export function commentStatus(c: Comment): CommentStatus {
  if (c.resolvedAt !== null) return "resolved";
  if (c.sentAt !== null) return "sent";
  return "pending";
}

/// A comment with `line === 0` covers the whole file rather than a line.
export function isFileLevel(c: Pick<Comment, "line">): boolean {
  return c.line === 0;
}

/// Compact anchor for UI: `a.rs`, `a.rs:7`, `a.rs:7–12`. Base-side
/// (removed-line) comments are marked by the caller, since the UI shows
/// that as a badge rather than text.
export function anchorLabel(
  c: Pick<Comment, "filePath" | "line" | "endLine">,
): string {
  if (isFileLevel(c)) return c.filePath;
  if (c.endLine !== null && c.endLine !== c.line) {
    return `${c.filePath}:${c.line}–${c.endLine}`;
  }
  return `${c.filePath}:${c.line}`;
}

/// Short sha for display: `3c611bc`.
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/// Anchor as the agent should read it. Removed-line numbers refer to the
/// base version, which the agent can't see in the working tree, so say so.
/// Comments made on a single commit name it: their numbering is from that
/// commit (or its parent), not the working tree.
function anchorForAgent(
  c: Pick<Comment, "filePath" | "line" | "endLine" | "side" | "commit">,
): string {
  const sha = c.commit ? shortSha(c.commit) : null;
  if (isFileLevel(c)) {
    return sha
      ? `${c.filePath} (whole file, as changed in commit ${sha})`
      : `${c.filePath} (whole file)`;
  }
  const lines =
    c.endLine !== null && c.endLine !== c.line
      ? `${c.filePath}:${c.line}-${c.endLine}`
      : `${c.filePath}:${c.line}`;
  const noun = c.endLine !== null && c.endLine !== c.line ? "lines" : "line";
  if (sha) {
    return c.side === "base"
      ? `${lines} (${noun} removed in commit ${sha} — numbering is from its parent, ${sha}^)`
      : `${lines} (in commit ${sha} — numbering is from that commit's version of the file)`;
  }
  if (c.side === "base") {
    return `${lines} (removed ${noun} — numbering is from the diff base)`;
  }
  return lines;
}

/// Key for per-branch review state. Same `(workspaceRoot, branch)` pair the
/// persisted comments are scoped by, since worktree IDs don't survive a
/// restart.
export function reviewKey(workspaceRoot: string, branch: string): string {
  return `${workspaceRoot}::${branch}`;
}

type CommentsState = {
  /// Loaded once on app startup; in-memory copy is the source of truth.
  /// Mutations write the full list back via save_comments.
  items: Comment[];
  /// MR thread ids pulled into the next review batch, per `reviewKey`.
  /// In-memory only — threads live on the forge, this is just a selection.
  includedThreads: Record<string, string[]>;
  /// Draft summary message for the next review batch, per `reviewKey`.
  summaries: Record<string, string>;
  loaded: boolean;
  load: () => Promise<void>;
  add: (
    fields: Pick<Comment, "workspaceRoot" | "branch" | "filePath" | "line" | "text"> &
      Partial<Pick<Comment, "endLine" | "side" | "commit">>,
  ) => Promise<Comment | null>;
  updateText: (id: string, text: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /// Mark comments as handed to an agent (pending → sent).
  markSent: (ids: string[]) => Promise<void>;
  /// Put a sent or resolved comment back into the next batch.
  markPending: (id: string) => Promise<void>;
  resolve: (id: string) => Promise<void>;
  resolveMany: (ids: string[]) => Promise<void>;
  /// Reopen a resolved comment; it returns to sent or pending.
  unresolve: (id: string) => Promise<void>;
  toggleThread: (key: string, threadId: string) => void;
  setSummary: (key: string, text: string) => void;
  /// Drop the batch extras (included threads + summary) after a send.
  clearBatch: (key: string) => void;
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

export const useCommentsStore = create<CommentsState>((set, get) => {
  /// Apply `fn` to the comments whose id is in `ids`, persist, and toast
  /// `failure` on error.
  async function update(
    ids: string[],
    fn: (c: Comment) => Comment,
    failure: string,
  ): Promise<void> {
    const want = new Set(ids);
    const next = get().items.map((c) => (want.has(c.id) ? fn(c) : c));
    try {
      set({ items: await persist(next) });
    } catch (e) {
      toastError(failure, asMessage(e));
    }
  }

  return {
    items: [],
    includedThreads: {},
    summaries: {},
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
        endLine: fields.endLine ?? null,
        side: fields.side ?? "head",
        commit: fields.commit ?? null,
        text: fields.text,
        createdAt: nowMs(),
        sentAt: null,
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
    updateText(id, text) {
      return update([id], (c) => ({ ...c, text }), "Couldn't update comment");
    },
    async remove(id) {
      const next = get().items.filter((c) => c.id !== id);
      try {
        set({ items: await persist(next) });
      } catch (e) {
        toastError("Couldn't delete comment", asMessage(e));
      }
    },
    markSent(ids) {
      const ts = nowMs();
      return update(ids, (c) => ({ ...c, sentAt: ts }), "Couldn't update comments");
    },
    markPending(id) {
      return update(
        [id],
        (c) => ({ ...c, sentAt: null, resolvedAt: null }),
        "Couldn't update comment",
      );
    },
    resolve(id) {
      return get().resolveMany([id]);
    },
    resolveMany(ids) {
      const ts = nowMs();
      return update(ids, (c) => ({ ...c, resolvedAt: ts }), "Couldn't resolve comment");
    },
    unresolve(id) {
      return update([id], (c) => ({ ...c, resolvedAt: null }), "Couldn't reopen comment");
    },
    toggleThread(key, threadId) {
      const cur = get().includedThreads[key] ?? [];
      const next = cur.includes(threadId)
        ? cur.filter((t) => t !== threadId)
        : [...cur, threadId];
      set({ includedThreads: { ...get().includedThreads, [key]: next } });
    },
    setSummary(key, text) {
      set({ summaries: { ...get().summaries, [key]: text } });
    },
    clearBatch(key) {
      const { [key]: _t, ...includedThreads } = get().includedThreads;
      const { [key]: _s, ...summaries } = get().summaries;
      set({ includedThreads, summaries });
    },
  };
});

/// Format a comment's payload for sending to an agent over its stdin.
/// Matches the pattern the user OK'd:
///
///     Review comment on <path>:<line>
///
///     <text>
export function formatCommentForAgent(c: Comment): string {
  return `Review comment on ${anchorForAgent(c)}\n\n${c.text}\n`;
}

/// Format a batch of comments as one structured message — a short header
/// listing the count, then each comment block separated by horizontal
/// rules. Sent as a single write to the agent's stdin.
export function formatBatchForAgent(cs: Comment[]): string {
  const header = `Review comments (${cs.length}):\n`;
  const blocks = cs
    .map((c) => `[${anchorForAgent(c)}]\n${c.text}`)
    .join("\n\n---\n\n");
  return `${header}\n${blocks}\n`;
}

/// Format a whole review batch as one prompt: the optional summary first,
/// then the local comments, then any MR threads pulled into the batch
/// (already formatted by `formatThreadForAgent`).
export function formatReviewForAgent(
  summary: string,
  comments: Comment[],
  threadTexts: string[],
): string {
  const parts: string[] = [];
  const s = summary.trim();
  if (s) parts.push(s);
  if (comments.length > 0) parts.push(formatBatchForAgent(comments).trimEnd());
  for (const t of threadTexts) parts.push(t.trimEnd());
  return `${parts.join("\n\n---\n\n")}\n`;
}
