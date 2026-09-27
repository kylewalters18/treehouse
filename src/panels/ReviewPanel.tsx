import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitPullRequest,
  MessageSquare,
  RotateCcw,
  X,
} from "lucide-react";
import type {
  AgentSession,
  AgentSessionId,
  Comment,
  ForgeThread,
} from "@/ipc/types";
import { listAgentsForWorktree } from "@/ipc/client";
import {
  anchorLabel,
  commentStatus,
  formatReviewForAgent,
  isFileLevel,
  reviewKey,
  useCommentsStore,
} from "@/stores/comments";
import { useForgeStore, forgeBranchKey } from "@/stores/forge";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { useDiffsStore } from "@/stores/diffs";
import { workspaceForWorktree } from "@/stores/workspace";
import { pasteAndSubmit, resolveSendableAgent } from "@/lib/agent";
import { formatNoteForAgent, formatThreadForAgent } from "@/lib/forge-prompt";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import { asMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";
import { countBadge } from "@/lib/pane-chrome";

/// Bottom-pane "Review" tab: the worktree's review in one place.
///
/// Local first — your inline comments are always here, forge or not:
/// - **Pending**: every unsent comment, plus any MR threads you pulled in,
///   with an optional summary. One Send hands the whole batch to an agent
///   as a single prompt (or posts the comments to the MR as a review).
/// - **Sent**: handed to an agent, waiting on the fix. Resolve once done.
/// - **Resolved**: collapsed history.
///
/// When the branch has an MR, its threads and conversation follow as extra
/// sections; without one those sections simply don't render.
export function ReviewPanel() {
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId);
  const activeAgentId = useUiStore((s) =>
    s.selectedWorktreeId
      ? s.activeAgentByWorktree[s.selectedWorktreeId] ?? null
      : null,
  );
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const selected = worktrees.find((w) => w.id === selectedWorktreeId) ?? null;
  const workspace = workspaceForWorktree(selected?.workspaceId);

  const wsId = workspace?.id ?? null;
  const root = workspace?.root ?? "";
  const branch = selected?.branch ?? null;
  const key = reviewKey(root, branch ?? "");

  // --- Local comments ---
  const items = useCommentsStore((s) => s.items);
  const includedIds = useCommentsStore((s) => s.includedThreads[key]);
  const summary = useCommentsStore((s) => s.summaries[key] ?? "");
  const setSummary = useCommentsStore((s) => s.setSummary);
  const toggleThread = useCommentsStore((s) => s.toggleThread);
  const clearBatch = useCommentsStore((s) => s.clearBatch);
  const markSent = useCommentsStore((s) => s.markSent);
  const markPending = useCommentsStore((s) => s.markPending);
  const resolveComment = useCommentsStore((s) => s.resolve);
  const resolveMany = useCommentsStore((s) => s.resolveMany);
  const unresolveComment = useCommentsStore((s) => s.unresolve);
  const removeComment = useCommentsStore((s) => s.remove);

  const { pending, sent, resolved } = useMemo(() => {
    const mine = items
      .filter((c) => c.workspaceRoot === root && c.branch === branch)
      .sort((a, b) =>
        a.filePath === b.filePath
          ? a.line - b.line
          : a.filePath.localeCompare(b.filePath),
      );
    return {
      pending: mine.filter((c) => commentStatus(c) === "pending"),
      sent: mine.filter((c) => commentStatus(c) === "sent"),
      resolved: mine.filter((c) => commentStatus(c) === "resolved"),
    };
  }, [items, root, branch]);

  // --- Forge (optional) ---
  const findMr = useForgeStore((s) => s.findMr);
  const loadThreads = useForgeStore((s) => s.loadThreads);
  const replyThread = useForgeStore((s) => s.replyThread);
  const resolveThread = useForgeStore((s) => s.resolveThread);
  const postMrComment = useForgeStore((s) => s.postMrComment);
  const postReviewComments = useForgeStore((s) => s.postReviewComments);
  const mr = useForgeStore((s) =>
    wsId && branch ? s.mrByBranch[forgeBranchKey(wsId, branch)] : undefined,
  );
  const threads = useForgeStore((s) =>
    wsId && mr ? s.threadsByMr[`${wsId}::mr::${mr.number}`] : undefined,
  );

  // `findMr` leaves the store untouched when the forge is unreachable, so
  // `mr` can stay `undefined` forever. Nothing local waits on it — MR
  // sections just render once (if) an MR shows up.
  useEffect(() => {
    if (wsId && branch && mr === undefined) void findMr(wsId, branch);
  }, [wsId, branch, mr, findMr]);
  useEffect(() => {
    if (wsId && mr) void loadThreads(wsId, mr.number);
  }, [wsId, mr, loadThreads]);

  const { inline, general, includedThreads } = useMemo(() => {
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
    const ids = new Set(includedIds ?? []);
    const includedThreads = (threads ?? []).filter((t) => ids.has(t.id));
    return { inline, general, includedThreads };
  }, [threads, includedIds]);

  const unresolvedThreads = useMemo(
    () => (threads ?? []).filter((t) => t.resolvable && !t.resolved),
    [threads],
  );

  // --- Send target ---
  const [agents, setAgents] = useState<AgentSession[]>([]);
  const [targetId, setTargetId] = useState<AgentSessionId | null>(null);
  const batchSize = pending.length + includedThreads.length;
  useEffect(() => {
    if (!selectedWorktreeId) return;
    let cancelled = false;
    listAgentsForWorktree(selectedWorktreeId)
      .then((list) => {
        if (cancelled) return;
        const sendable = list.filter(
          (a) => a.status.kind === "running" || a.status.kind === "starting",
        );
        setAgents(sendable);
        setTargetId((prev) => {
          if (prev && sendable.some((a) => a.id === prev)) return prev;
          if (activeAgentId && sendable.some((a) => a.id === activeAgentId)) {
            return activeAgentId;
          }
          return sendable[0]?.id ?? null;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setAgents([]);
        setTargetId(null);
      });
    return () => {
      cancelled = true;
    };
    // Re-list when the batch changes size so an agent launched since the
    // tab opened shows up before you hit Send.
  }, [selectedWorktreeId, activeAgentId, batchSize]);

  const labels = useUiStore((s) => s.agentLabelsBySessionId);
  const [showPreview, setShowPreview] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [resolvingAll, setResolvingAll] = useState(false);

  const selectFile = useDiffsStore((s) => s.selectFile);
  const setView = useDiffsStore((s) => s.setView);
  const setPendingReveal = useDiffsStore((s) => s.setPendingReveal);

  if (!selected || !workspace || !branch) {
    return <Empty>Select a worktree to see its review.</Empty>;
  }

  const prompt = formatReviewForAgent(
    summary,
    pending,
    includedThreads.map(formatThreadForAgent),
  );

  function jump(path: string, line: number) {
    if (!selectedWorktreeId) return;
    setView(selectedWorktreeId, "file");
    selectFile(selectedWorktreeId, path);
    setPendingReveal(selectedWorktreeId, { path, line, column: 1 });
  }

  /// Jump to a local comment. Removed-line comments only exist in the diff,
  /// so they open the Diff view; everything else reveals in the File view.
  function jumpToComment(c: Comment) {
    if (!selectedWorktreeId) return;
    if (c.side === "base") {
      setView(selectedWorktreeId, "diff");
      selectFile(selectedWorktreeId, c.filePath);
      return;
    }
    jump(c.filePath, Math.max(1, c.line));
  }

  async function sendReview() {
    if (!targetId) {
      toastInfo("No running agent in this worktree");
      return;
    }
    setBusy(true);
    try {
      await pasteAndSubmit(targetId, prompt);
      await markSent(pending.map((c) => c.id));
      clearBatch(key);
      toastSuccess(
        "Review sent",
        `${batchSize} item${batchSize === 1 ? "" : "s"} — resolve them once the agent is done.`,
      );
    } catch (e) {
      toastError("Couldn't send review", asMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /// Post the pending comments as an inline MR review (+ the summary as a
  /// general comment). They then live on the MR as threads, so the local
  /// copies are resolved rather than left as duplicates. Pulled-in MR
  /// threads stay in the batch — they're already on the MR.
  async function postToMr() {
    if (!wsId || !mr || pending.length === 0) return;
    setBusy(true);
    // Line comments go up as inline threads, anchored on a range's last
    // line with the range spelled out in the body; whole-file comments go
    // up as general MR comments naming the file.
    const inlineComments = pending.filter((c) => !isFileLevel(c));
    const fileComments = pending.filter(isFileLevel);
    let ok =
      inlineComments.length === 0 ||
      (await postReviewComments(
        wsId,
        mr.number,
        inlineComments.map((c) => ({
          filePath: c.filePath,
          line: c.endLine ?? c.line,
          removed: c.side === "base",
          body:
            c.endLine !== null && c.endLine !== c.line
              ? `Lines ${c.line}–${c.endLine}:\n\n${c.text}`
              : c.text,
        })),
      ));
    for (const c of fileComments) {
      if (!ok) break;
      ok = await postMrComment(wsId, mr.number, `**${c.filePath}**\n\n${c.text}`);
    }
    if (ok) {
      if (summary.trim()) await postMrComment(wsId, mr.number, summary.trim());
      await resolveMany(pending.map((c) => c.id));
      setSummary(key, "");
      toastSuccess(
        `Posted ${pending.length} comment${pending.length === 1 ? "" : "s"} to !${mr.number}`,
      );
    }
    setBusy(false);
  }

  /// One-off send of a single MR thread / note, outside the batch.
  async function sendToAgent(text: string, label: string) {
    if (!selectedWorktreeId) return;
    try {
      const agentId = await resolveSendableAgent(selectedWorktreeId, activeAgentId);
      if (!agentId) {
        toastInfo("No running agent in this worktree");
        return;
      }
      await pasteAndSubmit(agentId, text);
      toastSuccess(`Sent ${label} to agent`);
    } catch (e) {
      toastError("Couldn't send to agent", asMessage(e));
    }
  }

  function reply(discussionId: string, body: string) {
    if (!wsId || !mr) return Promise.resolve(false);
    return replyThread(wsId, mr.number, discussionId, body);
  }

  function resolveMrThread(discussionId: string, resolved: boolean) {
    if (!wsId || !mr) return Promise.resolve(false);
    return resolveThread(wsId, mr.number, discussionId, resolved);
  }

  async function resolveAllThreads() {
    if (!wsId || !mr) return;
    setResolvingAll(true);
    // Snapshot up front — each resolve reloads threads.
    for (const t of [...unresolvedThreads]) {
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

  const included = new Set(includedIds ?? []);
  const threadProps = (thread: ForgeThread) => ({
    thread,
    included: included.has(thread.id),
    onToggleInclude: () => toggleThread(key, thread.id),
    onReply: (body: string) => reply(thread.id, body),
    onResolve: (r: boolean) => resolveMrThread(thread.id, r),
    onSendToAgent: sendToAgent,
  });

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-xs">
      {/* Context strip: the MR when there is one, else the local branch. */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-neutral-800 px-3">
        {mr ? (
          <>
            <GitPullRequest size={13} className="shrink-0 text-violet-400" />
            <span className="font-mono text-[11px] text-neutral-500">!{mr.number}</span>
            <span className="min-w-0 flex-1 truncate text-neutral-200">{mr.title}</span>
            <StateBadge state={mr.state} />
          </>
        ) : (
          <>
            <GitBranch size={13} className="shrink-0 text-neutral-500" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-300">
              {branch}
            </span>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {/* --- Pending batch --- */}
        <SectionHeader label="Pending" count={batchSize} />
        {batchSize === 0 ? (
          <Muted>
            No pending comments. Click <span className="text-neutral-400">+</span>{" "}
            in the editor gutter to start a review.
          </Muted>
        ) : (
          <div className="flex flex-col gap-1.5">
            {pending.map((c) => (
              <CommentRow
                key={c.id}
                comment={c}
                rail="bg-blue-400"
                onJump={() => jumpToComment(c)}
                actions={
                  <RowIconButton
                    title="Delete comment"
                    onClick={() => void removeComment(c.id)}
                    danger
                  >
                    <X size={12} />
                  </RowIconButton>
                }
              />
            ))}
            {includedThreads.map((t) => (
              <IncludedThreadRow
                key={t.id}
                thread={t}
                onJump={jump}
                onRemove={() => toggleThread(key, t.id)}
              />
            ))}

            <textarea
              value={summary}
              onChange={(e) => setSummary(key, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) {
                  e.preventDefault();
                  void sendReview();
                }
              }}
              rows={2}
              placeholder="Summary for the agent (optional) — e.g. “focus on error handling; naming nits are minor”"
              className="mt-1 w-full resize-none rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-100 placeholder:text-neutral-600 transition-colors focus:border-blue-500/60 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
            />
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setShowPreview((v) => !v)}
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
              >
                {showPreview ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Preview prompt
              </button>
              <span className="flex-1" />
              {mr && pending.length > 0 && (
                <button
                  disabled={busy}
                  onClick={() => void postToMr()}
                  title="Post the pending comments to the MR as an inline review"
                  className="flex h-6 items-center rounded-md border border-neutral-700 px-2 text-[11px] text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40"
                >
                  Post to !{mr.number}
                </button>
              )}
              {agents.length > 1 && (
                <select
                  value={targetId ?? ""}
                  onChange={(e) => setTargetId(e.target.value as AgentSessionId)}
                  title="Agent to send the review to"
                  className="h-6 max-w-[14rem] rounded-md border border-neutral-700 bg-neutral-900 px-1.5 text-[11px] text-neutral-200 focus:border-blue-500/60 focus:outline-none"
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {labels[a.id] ?? backendLabel(a)}
                      {a.id === activeAgentId ? " (active tab)" : ""}
                    </option>
                  ))}
                </select>
              )}
              <button
                disabled={busy || !targetId}
                onClick={() => void sendReview()}
                title={
                  targetId
                    ? "Send the whole review to the agent as one prompt (⌘↵ in the summary)"
                    : "No running agent in this worktree"
                }
                className="flex h-6 items-center gap-1.5 rounded-md bg-blue-600 px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-blue-600"
              >
                Send to agent
                <span className="rounded-full bg-white/20 px-1.5 font-mono text-[10px] leading-4 tabular-nums">
                  {batchSize}
                </span>
              </button>
            </div>
            {showPreview && (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-[11px] text-neutral-300">
                {prompt}
              </pre>
            )}
          </div>
        )}

        {/* --- Sent, awaiting the agent --- */}
        {sent.length > 0 && (
          <>
            <SectionHeader
              label="Sent"
              count={sent.length}
              className="mt-4"
              action={
                <button
                  onClick={() => void resolveMany(sent.map((c) => c.id))}
                  className="flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-neutral-400 transition-colors hover:bg-emerald-400/10 hover:text-emerald-300"
                >
                  <Check size={12} />
                  Resolve all
                </button>
              }
            />
            <div className="flex flex-col gap-1.5">
              {sent.map((c) => (
                <CommentRow
                  key={c.id}
                  comment={c}
                  rail="bg-neutral-500"
                  onJump={() => jumpToComment(c)}
                  actions={
                    <>
                      <RowIconButton
                        title="Move back to pending (goes out with the next review)"
                        onClick={() => void markPending(c.id)}
                      >
                        <RotateCcw size={12} />
                      </RowIconButton>
                      <button
                        onClick={() => void resolveComment(c.id)}
                        className="flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-neutral-400 transition-colors hover:bg-emerald-400/10 hover:text-emerald-300"
                      >
                        <Check size={12} />
                        Resolve
                      </button>
                    </>
                  }
                />
              ))}
            </div>
          </>
        )}

        {/* --- Resolved history (collapsed) --- */}
        {resolved.length > 0 && (
          <>
            <button
              onClick={() => setShowResolved((v) => !v)}
              className="mt-4 mb-1.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-neutral-500 transition-colors hover:text-neutral-300"
            >
              {showResolved ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Resolved
              <span className={countBadge("neutral")}>{resolved.length}</span>
            </button>
            {showResolved && (
              <div className="flex flex-col gap-1.5 opacity-70">
                {resolved.map((c) => (
                  <CommentRow
                    key={c.id}
                    comment={c}
                    rail="bg-neutral-700"
                    onJump={() => jumpToComment(c)}
                    actions={
                      <>
                        <button
                          onClick={() => void unresolveComment(c.id)}
                          className="flex h-5 items-center rounded px-1.5 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
                        >
                          Reopen
                        </button>
                        <RowIconButton
                          title="Delete comment"
                          onClick={() => void removeComment(c.id)}
                          danger
                        >
                          <X size={12} />
                        </RowIconButton>
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* --- MR (only when the branch has one) --- */}
        {mr && (
          <>
            <SectionHeader
              label="MR threads"
              count={inline.length}
              className="mt-5"
              action={
                unresolvedThreads.length > 0 && (
                  <button
                    disabled={resolvingAll}
                    onClick={() => void resolveAllThreads()}
                    title="Resolve every open review thread on the MR"
                    className="flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-neutral-400 transition-colors hover:bg-emerald-400/10 hover:text-emerald-300 disabled:opacity-50"
                  >
                    <Check size={12} />
                    {resolvingAll ? "Resolving…" : `Resolve all (${unresolvedThreads.length})`}
                  </button>
                )
              }
            />
            {inline.length === 0 ? (
              <Muted>No inline review threads.</Muted>
            ) : (
              <div className="flex flex-col gap-1.5">
                {inline.map(({ thread, path, line }) => (
                  <ThreadCard
                    key={thread.id}
                    {...threadProps(thread)}
                    anchor={
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          jump(path, line);
                        }}
                        className="font-mono text-[11px] text-blue-400 hover:underline"
                        title="Jump to this line in the editor"
                      >
                        {path}:{line}
                      </button>
                    }
                  />
                ))}
              </div>
            )}

            <SectionHeader label="MR conversation" count={general.length} className="mt-4" />
            {general.length === 0 ? (
              <Muted>No general comments.</Muted>
            ) : (
              <div className="flex flex-col gap-1.5">
                {general.map((thread) => (
                  <ThreadCard key={thread.id} {...threadProps(thread)} />
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
                className="flex-1 resize-none rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-100 placeholder:text-neutral-600 transition-colors focus:border-blue-500/60 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
              />
              <button
                disabled={posting || !newComment.trim()}
                onClick={() => void onPost()}
                className="flex h-7 items-center rounded-md border border-neutral-700 px-3 text-[11px] font-medium text-neutral-200 transition-colors hover:bg-neutral-800 disabled:opacity-40"
              >
                Post
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/// One local comment: a status rail, the `path:line` anchor (click to jump),
/// the text, and row-specific actions on the right.
function CommentRow({
  comment,
  rail,
  onJump,
  actions,
}: {
  comment: Comment;
  rail: string;
  onJump: () => void;
  actions: React.ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-md border border-neutral-800 bg-neutral-900">
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[2px]", rail)} />
      <div className="flex items-start gap-2 py-1.5 pl-3 pr-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              onClick={onJump}
              className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-blue-400 hover:underline"
              title="Jump to this comment in the editor"
            >
              <MessageSquare size={11} className="shrink-0 text-neutral-500" />
              <span className="truncate">{anchorLabel(comment)}</span>
            </button>
            {comment.side === "base" && (
              <span
                className={countBadge("danger")}
                title="On lines removed from the diff base — opens in the Diff view"
              >
                removed
              </span>
            )}
          </div>
          <div className="mt-0.5 whitespace-pre-wrap leading-relaxed text-neutral-200">
            {comment.text}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
      </div>
    </div>
  );
}

/// An MR thread pulled into the pending batch — compact, with a remove.
function IncludedThreadRow({
  thread,
  onJump,
  onRemove,
}: {
  thread: ForgeThread;
  onJump: (path: string, line: number) => void;
  onRemove: () => void;
}) {
  const first = thread.notes[0];
  const anchor = thread.notes.find(
    (n) => n.position?.newPath != null && n.position?.newLine != null,
  )?.position;
  const preview = (first?.body ?? "").replace(/\s+/g, " ").trim();
  return (
    <div className="relative overflow-hidden rounded-md border border-neutral-800 bg-neutral-900">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-violet-400" />
      <div className="flex items-center gap-2 py-1.5 pl-3 pr-1.5">
        <GitPullRequest size={11} className="shrink-0 text-violet-400" />
        <span className="shrink-0 text-[11px] font-medium text-neutral-300">
          @{first?.author ?? "unknown"}
        </span>
        {anchor?.newPath != null && anchor.newLine != null && (
          <button
            onClick={() => onJump(anchor.newPath!, anchor.newLine!)}
            className="shrink-0 font-mono text-[11px] text-blue-400 hover:underline"
          >
            {anchor.newPath}:{anchor.newLine}
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-neutral-500">{preview}</span>
        <span className={countBadge("neutral")}>{thread.notes.length}</span>
        <RowIconButton title="Remove from this review" onClick={onRemove}>
          <X size={12} />
        </RowIconButton>
      </div>
    </div>
  );
}

function RowIconButton({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded text-neutral-500 transition-colors",
        danger
          ? "hover:bg-rose-400/10 hover:text-rose-400"
          : "hover:bg-neutral-800 hover:text-neutral-100",
      )}
    >
      {children}
    </button>
  );
}

/// Collapsible MR thread card. Header shows author, note count, optional inline
/// anchor, and a one-line preview when collapsed; expands to the full notes +
/// a reply box. Defaults collapsed so the list stays scannable.
function ThreadCard({
  thread,
  anchor,
  included,
  onToggleInclude,
  onReply,
  onResolve,
  onSendToAgent,
}: {
  thread: ForgeThread;
  anchor?: React.ReactNode;
  /// Whether the thread is pulled into the pending review batch.
  included: boolean;
  onToggleInclude: () => void;
  onReply: (body: string) => Promise<boolean>;
  onResolve: (resolved: boolean) => Promise<boolean>;
  onSendToAgent: (text: string, label: string) => void;
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
        "overflow-hidden rounded-md border bg-neutral-900",
        thread.resolved ? "border-neutral-800/60 opacity-60" : "border-neutral-800",
        included && "border-blue-400/40",
      )}
    >
      <div
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-neutral-800/40"
      >
        <span className="shrink-0 text-neutral-500">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <Avatar name={author} />
        <span className="shrink-0 font-medium text-neutral-300">@{author}</span>
        {anchor && <span className="shrink-0">{anchor}</span>}
        {!open && (
          <span className="min-w-0 flex-1 truncate text-neutral-500">{preview}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <span className={countBadge("neutral")}>{thread.notes.length}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleInclude();
            }}
            title={
              included
                ? "Remove from the pending review"
                : "Include this thread in the next review sent to the agent"
            }
            className={cn(
              "flex h-5 items-center rounded px-1.5 text-[11px] transition-colors",
              included
                ? "bg-blue-400/15 text-blue-300 hover:bg-blue-400/20"
                : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
            )}
          >
            {included ? "In review" : "Add to review"}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSendToAgent(formatThreadForAgent(thread), "thread");
            }}
            title="Send just this thread to the agent now"
            className="flex h-5 items-center rounded px-1.5 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
          >
            Send now
          </button>
          {thread.resolvable && (
            <button
              onClick={toggleResolved}
              disabled={busy}
              title={thread.resolved ? "Reopen thread" : "Resolve thread"}
              className={cn(
                "flex h-5 items-center gap-1 rounded px-1.5 text-[11px] transition-colors disabled:opacity-50",
                thread.resolved
                  ? "text-emerald-400 hover:bg-neutral-800"
                  : "text-neutral-400 hover:bg-emerald-400/10 hover:text-emerald-300",
              )}
            >
              <Check size={12} />
              {thread.resolved ? "Resolved" : "Resolve"}
            </button>
          )}
        </span>
      </div>

      {open && (
        <div className="flex flex-col gap-1.5 border-t border-neutral-800 px-2 py-2">
          {thread.notes.map((n) => (
            <div key={n.id} className="group flex gap-2">
              <Avatar name={n.author} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-neutral-400">@{n.author}</span>
                  <button
                    onClick={() => onSendToAgent(formatNoteForAgent(n), "comment")}
                    title="Send just this comment to the agent now"
                    className="flex h-4 items-center rounded px-1 text-[10px] text-neutral-500 opacity-0 transition hover:bg-neutral-800 hover:text-neutral-200 group-hover:opacity-100"
                  >
                    Send now
                  </button>
                </div>
                <div className="whitespace-pre-wrap leading-relaxed text-neutral-200">{n.body}</div>
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
              className="h-6 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-neutral-100 placeholder:text-neutral-600 transition-colors focus:border-blue-500/60 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
            />
            <button
              disabled={busy || !reply.trim()}
              onClick={() => void submit()}
              className="flex h-6 items-center rounded-md bg-blue-600 px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600"
            >
              {busy ? "…" : "Reply"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/// Display label for an agent in the send-target picker.
function backendLabel(a: AgentSession): string {
  switch (a.backend) {
    case "claudeCode":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "kiro":
      return "Kiro";
  }
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
        "shrink-0 rounded-full px-1.5 text-[10px] leading-4",
        state === "merged"
          ? "bg-violet-400/15 text-violet-300"
          : state === "closed"
            ? "bg-rose-400/15 text-rose-300"
            : "bg-emerald-400/15 text-emerald-300",
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
  action,
}: {
  label: string;
  count: number;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={cn("mb-1.5 flex items-center gap-1.5", className)}>
      <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-neutral-500">
        {label}
      </span>
      <span className={countBadge(label === "Pending" && count > 0 ? "accent" : "neutral")}>
        {count}
      </span>
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div className="px-1 py-1 text-neutral-600">{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-neutral-600">
      {children}
    </div>
  );
}
