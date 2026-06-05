import { useEffect, useMemo, useState } from "react";
import type { ForgeThread } from "@/ipc/types";
import { useForgeStore, forgeBranchKey } from "@/stores/forge";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { useDiffsStore } from "@/stores/diffs";
import { workspaceForWorktree } from "@/stores/workspace";
import { cn } from "@/lib/cn";

/// Bottom-pane "Review" tab: all MR discussion in one place — inline review
/// threads (click the file:line to jump to it in the editor) and general
/// (non-line) comments. Threads are collapsible cards; the inline anchor and
/// a preview keep the list scannable when collapsed.
export function ReviewPanel() {
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const selected = worktrees.find((w) => w.id === selectedWorktreeId) ?? null;
  const workspace = workspaceForWorktree(selected?.workspaceId);

  const findMr = useForgeStore((s) => s.findMr);
  const loadThreads = useForgeStore((s) => s.loadThreads);
  const replyThread = useForgeStore((s) => s.replyThread);
  const resolveThread = useForgeStore((s) => s.resolveThread);
  const postMrComment = useForgeStore((s) => s.postMrComment);
  const mr = useForgeStore((s) =>
    workspace && selected
      ? s.mrByBranch[forgeBranchKey(workspace.id, selected.branch)]
      : undefined,
  );
  const threads = useForgeStore((s) =>
    workspace && mr ? s.threadsByMr[`${workspace.id}::mr::${mr.number}`] : undefined,
  );

  const selectFile = useDiffsStore((s) => s.selectFile);
  const setView = useDiffsStore((s) => s.setView);
  const setPendingReveal = useDiffsStore((s) => s.setPendingReveal);

  const [newComment, setNewComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [resolvingAll, setResolvingAll] = useState(false);

  const wsId = workspace?.id ?? null;
  const branch = selected?.branch ?? null;

  const unresolved = useMemo(
    () => (threads ?? []).filter((t) => t.resolvable && !t.resolved),
    [threads],
  );

  useEffect(() => {
    if (wsId && branch && mr === undefined) void findMr(wsId, branch);
  }, [wsId, branch, mr, findMr]);
  useEffect(() => {
    if (wsId && mr) void loadThreads(wsId, mr.number);
  }, [wsId, mr, loadThreads]);

  const { inline, general } = useMemo(() => {
    const inline: { thread: ForgeThread; path: string; line: number }[] = [];
    const general: ForgeThread[] = [];
    for (const t of threads ?? []) {
      const anchor = t.notes.find(
        (n) => n.position?.newPath != null && n.position?.newLine != null,
      );
      if (anchor?.position?.newPath != null && anchor.position.newLine != null) {
        inline.push({ thread: t, path: anchor.position.newPath, line: anchor.position.newLine });
      } else if (t.notes.length > 0) {
        general.push(t);
      }
    }
    return { inline, general };
  }, [threads]);

  if (!selected) return <Empty>Select a worktree to see its MR review.</Empty>;
  if (mr === undefined) return <Empty>Looking up MR…</Empty>;
  if (mr === null) return <Empty>No MR for {selected.branch}.</Empty>;

  function jump(path: string, line: number) {
    if (!selectedWorktreeId) return;
    setView(selectedWorktreeId, "file");
    selectFile(selectedWorktreeId, path);
    setPendingReveal(selectedWorktreeId, { path, line, column: 1 });
  }

  function reply(discussionId: string, body: string) {
    if (!wsId || !mr) return Promise.resolve(false);
    return replyThread(wsId, mr.number, discussionId, body);
  }

  function resolve(discussionId: string, resolved: boolean) {
    if (!wsId || !mr) return Promise.resolve(false);
    return resolveThread(wsId, mr.number, discussionId, resolved);
  }

  async function resolveAll() {
    if (!wsId || !mr) return;
    setResolvingAll(true);
    // Snapshot up front — each resolve reloads threads, mutating `unresolved`.
    for (const t of [...unresolved]) {
      await resolveThread(wsId, mr.number, t.id, true);
    }
    setResolvingAll(false);
  }

  async function onPost() {
    if (!wsId || !mr) return;
    const body = newComment.trim();
    if (!body) return;
    setPosting(true);
    const ok = await postMrComment(wsId, mr.number, body);
    setPosting(false);
    if (ok) setNewComment("");
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-xs">
      {/* MR context header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
        <span className="font-mono text-[11px] text-neutral-500">!{mr.number}</span>
        <span className="min-w-0 flex-1 truncate text-neutral-200">{mr.title}</span>
        {unresolved.length > 0 && (
          <button
            disabled={resolvingAll}
            onClick={() => void resolveAll()}
            title="Resolve every open review thread"
            className="shrink-0 rounded border border-emerald-700 bg-emerald-950/40 px-2 py-0.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-950/60 disabled:opacity-50"
          >
            {resolvingAll ? "Resolving…" : `Resolve all (${unresolved.length})`}
          </button>
        )}
        <StateBadge state={mr.state} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <SectionHeader label="Inline comments" count={inline.length} />
        {inline.length === 0 ? (
          <Muted>No inline review comments.</Muted>
        ) : (
          <div className="flex flex-col gap-1.5">
            {inline.map(({ thread, path, line }) => (
              <ThreadCard
                key={thread.id}
                thread={thread}
                anchor={
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      jump(path, line);
                    }}
                    className="font-mono text-[11px] text-blue-300 hover:underline"
                    title="Jump to this line in the editor"
                  >
                    {path}:{line}
                  </button>
                }
                onReply={(body) => reply(thread.id, body)}
                onResolve={(resolved) => resolve(thread.id, resolved)}
              />
            ))}
          </div>
        )}

        <SectionHeader label="Conversation" count={general.length} className="mt-4" />
        {general.length === 0 ? (
          <Muted>No general comments.</Muted>
        ) : (
          <div className="flex flex-col gap-1.5">
            {general.map((thread) => (
              <ThreadCard
                key={thread.id}
                thread={thread}
                onReply={(body) => reply(thread.id, body)}
                onResolve={(resolved) => resolve(thread.id, resolved)}
              />
            ))}
          </div>
        )}

        <div className="mt-2 flex items-start gap-1.5">
          <textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void onPost();
            }}
            placeholder="Comment on the MR… (⌘↵ to post)"
            rows={2}
            className="flex-1 resize-none rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
          <button
            disabled={posting || !newComment.trim()}
            onClick={() => void onPost()}
            className="rounded-md border border-blue-700 bg-blue-950/40 px-3 py-1.5 font-medium text-blue-200 hover:bg-blue-950/60 disabled:opacity-40"
          >
            Post
          </button>
        </div>
      </div>
    </div>
  );
}

/// Collapsible thread card. Header shows author, note count, optional inline
/// anchor, and a one-line preview when collapsed; expands to the full notes +
/// a reply box. Defaults collapsed so the list stays scannable.
function ThreadCard({
  thread,
  anchor,
  onReply,
  onResolve,
}: {
  thread: ForgeThread;
  anchor?: React.ReactNode;
  onReply: (body: string) => Promise<boolean>;
  onResolve: (resolved: boolean) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  const first = thread.notes[0];
  const author = first?.author ?? "unknown";
  const preview = (first?.body ?? "").replace(/\s+/g, " ").trim();

  async function toggleResolved(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(true);
    await onResolve(!thread.resolved);
    setBusy(false);
  }

  async function submit() {
    const body = reply.trim();
    if (!body) return;
    setBusy(true);
    const ok = await onReply(body);
    setBusy(false);
    if (ok) {
      setReply("");
      setOpen(true);
    }
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-neutral-900/40",
        thread.resolved ? "border-neutral-800/60 opacity-60" : "border-neutral-800",
      )}
    >
      <div
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left hover:bg-neutral-900/70"
      >
        <span
          className={cn(
            "shrink-0 text-[9px] text-neutral-500 transition-transform",
            !open && "-rotate-90",
          )}
        >
          ▼
        </span>
        <Avatar name={author} />
        <span className="shrink-0 font-medium text-neutral-300">@{author}</span>
        {anchor && <span className="shrink-0">{anchor}</span>}
        {!open && (
          <span className="min-w-0 flex-1 truncate text-neutral-500">{preview}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="rounded-full bg-neutral-800 px-1.5 py-[1px] text-[10px] text-neutral-400">
            {thread.notes.length}
          </span>
          {thread.resolvable && (
            <button
              onClick={toggleResolved}
              disabled={busy}
              title={thread.resolved ? "Reopen thread" : "Resolve thread"}
              className={cn(
                "rounded border px-1.5 py-[1px] text-[10px] font-medium disabled:opacity-50",
                thread.resolved
                  ? "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
                  : "border-emerald-700 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-950/60",
              )}
            >
              {thread.resolved ? "✓ Resolved" : "Resolve"}
            </button>
          )}
        </span>
      </div>

      {open && (
        <div className="flex flex-col gap-1.5 border-t border-neutral-800 px-2 py-2">
          {thread.notes.map((n) => (
            <div key={n.id} className="flex gap-2">
              <Avatar name={n.author} />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] text-neutral-500">@{n.author}</div>
                <div className="whitespace-pre-wrap text-neutral-200">{n.body}</div>
              </div>
            </div>
          ))}
          <div className="mt-0.5 flex items-center gap-1.5">
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              placeholder="Reply…"
              className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            />
            <button
              disabled={busy || !reply.trim()}
              onClick={() => void submit()}
              className="rounded-md border border-blue-700 bg-blue-950/40 px-2.5 py-1 text-[11px] font-medium text-blue-200 hover:bg-blue-950/60 disabled:opacity-40"
            >
              {busy ? "…" : "Reply"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/// Deterministic colored initial circle for an author handle.
function Avatar({ name }: { name: string }) {
  const colors = [
    "bg-rose-800",
    "bg-amber-800",
    "bg-emerald-800",
    "bg-sky-800",
    "bg-violet-800",
    "bg-fuchsia-800",
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const color = colors[h % colors.length];
  return (
    <span
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold uppercase text-neutral-100",
        color,
      )}
    >
      {name.charAt(0) || "?"}
    </span>
  );
}

function StateBadge({ state }: { state: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-[1px] text-[10px]",
        state === "merged"
          ? "bg-purple-950/50 text-purple-300"
          : state === "closed"
            ? "bg-rose-950/50 text-rose-300"
            : "bg-emerald-950/50 text-emerald-300",
      )}
    >
      {state}
    </span>
  );
}

function SectionHeader({
  label,
  count,
  className,
}: {
  label: string;
  count: number;
  className?: string;
}) {
  return (
    <div className={cn("mb-1.5 flex items-center gap-1.5", className)}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      <span className="rounded-full bg-neutral-800 px-1.5 py-[1px] text-[10px] text-neutral-400">
        {count}
      </span>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div className="px-1 py-1 text-neutral-600">{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-neutral-950 p-4 text-sm text-neutral-500">
      {children}
    </div>
  );
}
