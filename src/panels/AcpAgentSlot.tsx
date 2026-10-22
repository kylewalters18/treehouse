import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowUpRight,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FileDiff,
  CircleCheck,
  CircleDot,
  FileText,
  Globe,
  Layers,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  MoveRight,
  Paperclip,
  Pencil,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  SquareTerminal,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  acpAnswerQuestion,
  acpCancel,
  acpRemoveFollowup,
  acpRespondPermission,
  acpSendPrompt,
  acpSetConfig,
  acpSetMode,
  readFile,
} from "@/ipc/client";
import type {
  AcpAttachment,
  AcpFollowup,
  AcpFormField,
  AcpPermissionRequest,
  AcpPlanEntry,
  AcpQuestion,
  AcpToolCall,
  AgentSessionId,
  CommitSummary,
  TurnFileChange,
  WorktreeId,
} from "@/ipc/types";
import { ForgeMarkdown } from "@/components/ForgeMarkdown";
import { CodeBlock, langForPath } from "@/components/CodeBlock";
import { cn } from "@/lib/cn";
import { asMessage } from "@/lib/errors";
import {
  activitySummary,
  canSubmitAnswer,
  commandOf,
  diffText,
  formatElapsed,
  isToolRunning,
  lineDiffStats,
  lineOfSnippet,
  questionAnswer,
  runningTool,
  stopReasonLabel,
  type AcpItem,
  type FormValue,
} from "@/lib/acp-transcript";
import { useActivityStore } from "@/stores/activity";
import { useDiffsStore } from "@/stores/diffs";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { openWorktreeFile } from "./term-path-links";
import { useToastsStore } from "@/stores/toasts";
import { createAcpLeafState, type AcpLeafState } from "./acp-leaf-state";
import { AcpPromptBox, isInterruptKey } from "./AcpPromptBox";
import { AcpPromptJumper, promptLabel, type PromptEntry } from "./AcpPromptJumper";
import { AcpFindBar, FindQueryContext } from "./AcpFindBar";
import { composerControls, type ComposerPicker } from "@/lib/acp-composer";
import { promptHistory } from "@/lib/acp-prompt";
import type { AgentLeafMode } from "./agent-leaf-state";

/// Below this pane width the layout compacts: icon-only toolbar pickers,
/// tighter gutters, a dot-only status.
const NARROW_PX = 520;

/// The element's content width, live; 0 until measured (and in tests,
/// which have no ResizeObserver — read as "wide").
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/// After this long without an event mid-turn, the transcript says the
/// agent is still thinking rather than sitting still.
const QUIET_MS = 1500;

/// A prompt scrolled above this line (px below the transcript's top, the
/// pinned header's height) pins as the header.
const PIN_PX = 28;

/// `Date.now()`, re-read every second while `active`.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/// Whether a keydown is a plain digit typed where it wouldn't be text:
/// outside any field, or into the composer while its draft is empty.
function digitShortcut(e: React.KeyboardEvent): number | null {
  if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key)) return null;
  const el = e.target as HTMLElement;
  const editable =
    el.isContentEditable ||
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement;
  const emptyComposer =
    el instanceof HTMLTextAreaElement && el.dataset.acpComposer !== undefined && el.value === "";
  return editable && !emptyComposer ? null : Number(e.key);
}

/// The worktree a transcript belongs to, for opening files it mentions.
const WorktreeContext = createContext<{ worktreeId: WorktreeId; root: string } | null>(null);

/// Slot view for one ACP agent tab: the structured counterpart of
/// `AgentLeafSlot`. State lives in the `acp-leaf-state` pool so it survives
/// remounts; this component only renders it.
export function AcpAgentSlot({
  worktreeId,
  mode,
  poolKey,
  visible,
  leafStates,
  onSession,
  insertRequest = null,
}: {
  worktreeId: WorktreeId;
  mode: AgentLeafMode;
  poolKey: string;
  visible: boolean;
  leafStates: Map<string, AcpLeafState>;
  onSession: (id: AgentSessionId) => void;
  /// Text to append to the composer's draft (see `AcpPromptBox`).
  insertRequest?: { text: string; nonce: number } | null;
}) {
  // Create (or adopt) the pooled state once per pool identity — see the
  // deps note on `AgentLeafSlot`.
  const [state] = useState(() => {
    let s = leafStates.get(poolKey);
    if (!s) {
      s = createAcpLeafState(worktreeId, mode, onSession);
      leafStates.set(poolKey, s);
    }
    return s;
  });
  useSyncExternalStore(
    (cb) => {
      state.listeners.add(cb);
      return () => state.listeners.delete(cb);
    },
    () => state.version,
  );
  const root = useWorktreesStore((s) => s.worktrees.find((w) => w.id === worktreeId)?.path ?? "");
  // The branch's commits, for linking hashes in replies (see `AgentText`);
  // refetched when the branch moves, as the History tab does.
  const ahead = useActivityStore((s) => s.byWorktree[worktreeId]?.ahead);
  const branchComputedAt = useDiffsStore((s) => s.byWorktree[worktreeId]?.computedAt);
  useEffect(() => {
    if (visible) void useDiffsStore.getState().fetchCommits(worktreeId).catch(() => {});
  }, [visible, worktreeId, ahead, branchComputedAt]);
  const worktreeCtx = useMemo(() => ({ worktreeId, root }), [worktreeId, root]);
  const t = state.transcript;
  const running = t.turns > 0 && !state.exited;
  const userTexts = t.items.flatMap((it) => (it.kind === "user" ? [it.text] : []));
  const history = useMemo(() => promptHistory(userTexts), [userTexts.join("\u0000")]);
  let lastUser = -1;
  let lastPrompt = -1;
  let lastTurnEnd = -1;
  t.items.forEach((it, i) => {
    if (it.kind === "user") lastPrompt = i;
    if (it.kind === "user" && it.text.trim()) lastUser = i;
    if (it.kind === "turnEnd") lastTurnEnd = i;
  });
  const now = useNow(running && visible);
  const activeTool = running ? runningTool(t.items) : null;
  const waitingOnUser = !!t.pendingPermission || !!t.pendingQuestion;
  const quiet = running && !waitingOnUser && !activeTool && now - state.lastEventAt > QUIET_MS;
  const pendingRequest = t.items.find(
    (it): it is Extract<AcpItem, { kind: "permission" }> =>
      it.kind === "permission" && it.request.id === t.pendingPermission && !it.resolved,
  )?.request;

  // Items mutate in place (see `applyAcpEvent`), so this isn't memoized.
  const prompts = t.items.flatMap((it, index): PromptEntry[] =>
    it.kind === "user" ? [{ index, label: promptLabel(it.text, it.attachments) }] : [],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useWidth(rootRef);
  const narrow = width > 0 && width < NARROW_PX;
  const stickToBottom = useRef(true);
  // The prompt pinned over the transcript: the latest one scrolled fully
  // past the top. None while a prompt is (partly) on screen at the top.
  const [pinnedPrompt, setPinnedPrompt] = useState<number | null>(null);
  function measurePinned() {
    const el = scrollRef.current;
    if (!el) return;
    let pinned: number | null = null;
    if (el.scrollTop > 0) {
      const top = el.getBoundingClientRect().top;
      for (const p of el.querySelectorAll<HTMLElement>("[data-prompt]")) {
        const r = p.getBoundingClientRect();
        if (r.top - top > PIN_PX) break;
        pinned = r.bottom - top <= PIN_PX ? Number(p.dataset.prompt) : null;
      }
    }
    setPinnedPrompt(pinned);
  }
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
    measurePinned();
  });
  function jumpToPrompt(index: number) {
    const el = scrollRef.current;
    const p = el?.querySelector<HTMLElement>(`[data-prompt="${index}"]`);
    if (!el || !p) return;
    el.scrollTop += p.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    measurePinned();
  }

  const [focusNonce, setFocusNonce] = useState(0);
  // ⌘F: null = closed.
  const [findQuery, setFindQuery] = useState<string | null>(null);
  const [findFocus, setFindFocus] = useState(0);
  function closeFind() {
    setFindQuery(null);
    setFocusNonce((n) => n + 1);
  }
  const [editRequest, setEditRequest] = useState<{ text: string; nonce: number } | null>(null);
  const [requeueRequest, setRequeueRequest] = useState<{
    followup: AcpFollowup;
    position: number;
    nonce: number;
  } | null>(null);
  const [restoreRequest, setRestoreRequest] = useState<{
    text: string;
    attachments: AcpAttachment[];
    nonce: number;
  } | null>(null);
  /// Put prompts that never went out back in the composer.
  function restore(followups: AcpFollowup[]) {
    if (followups.length === 0) return;
    setRestoreRequest((prev) => ({
      text: followups.map((f) => f.text.trim()).filter(Boolean).join("\n\n"),
      attachments: followups.flatMap((f) => f.attachments),
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  }
  const editLast = useMemo(
    () => (text: string) => setEditRequest((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 })),
    [],
  );
  useEffect(() => {
    if (visible) setFocusNonce((n) => n + 1);
  }, [visible]);

  function reportError(title: string, e: unknown) {
    useToastsStore.getState().push({ kind: "error", title, body: asMessage(e) });
  }

  async function send(
    text: string,
    attachments: AcpAttachment[],
    interrupt: boolean,
    position?: number,
  ): Promise<boolean> {
    if (!state.sessionId || state.exited) return false;
    stickToBottom.current = true;
    try {
      await acpSendPrompt(state.sessionId, text, attachments, interrupt, position);
      return true;
    } catch (e) {
      reportError("Couldn't send prompt", e);
      return false;
    }
  }

  async function cancel() {
    if (!state.sessionId) return;
    // Stopping takes queued follow-ups back into the composer, unsent.
    const dropped = await acpCancel(state.sessionId).catch((e) => {
      reportError("Couldn't cancel", e);
      return [];
    });
    restore(dropped);
  }

  /// Take a queued follow-up back. To edit (`position` = its place), it
  /// goes to the composer, which sends it back to that place.
  async function unqueue(f: AcpFollowup, position: number | null) {
    if (!state.sessionId) return;
    try {
      const removed = await acpRemoveFollowup(state.sessionId, f.id);
      if (!removed) {
        useToastsStore.getState().push({ kind: "info", title: "Already sent" });
      } else if (position !== null) {
        setRequeueRequest((prev) => ({ followup: removed, position, nonce: (prev?.nonce ?? 0) + 1 }));
      }
    } catch (e) {
      reportError("Couldn't change the queued prompt", e);
    }
  }

  async function setSetting(picker: ComposerPicker, value: string) {
    if (!state.sessionId) return;
    const req =
      picker.via === "config"
        ? acpSetConfig(state.sessionId, picker.option.id, value)
        : acpSetMode(state.sessionId, value);
    await req.catch((e) => reportError(`Couldn't change ${picker.option.name.toLowerCase()}`, e));
  }

  async function answerQuestion(
    q: AcpQuestion,
    action: "accept" | "decline",
    content?: Record<string, unknown>,
  ) {
    if (!state.sessionId) return;
    await acpAnswerQuestion(state.sessionId, q.id, action, content).catch((e) =>
      reportError("Couldn't answer the question", e),
    );
  }

  async function answer(req: AcpPermissionRequest, optionId: string) {
    if (!state.sessionId) return;
    await acpRespondPermission(state.sessionId, req.id, optionId).catch((e) =>
      reportError("Couldn't answer the permission request", e),
    );
  }

  const status: { label: string; tone: StatusTone } = state.error
    ? { label: "Failed to start", tone: "error" }
    : state.exited
      ? { label: "Exited", tone: "idle" }
      : !t.ready
        ? { label: "Starting…", tone: "busy" }
        : t.pendingPermission
          ? { label: "Needs permission", tone: "attention" }
          : t.pendingQuestion
            ? { label: "Has a question", tone: "attention" }
            : running
              ? { label: "Working", tone: "busy" }
              : { label: "Ready", tone: "ready" };
  const canEdit = !!state.sessionId && !state.exited && !state.error;
  // While working: how long, and what it's doing right now.
  const elapsed =
    running && !waitingOnUser && state.turnStartedAt !== null
      ? formatElapsed(now - state.turnStartedAt)
      : null;
  const activity = running && !waitingOnUser && activeTool ? toolTitle(activeTool) : null;

  return (
    <WorktreeContext.Provider value={worktreeCtx}>
    <FindQueryContext.Provider value={(findQuery ?? "").toLowerCase()}>
    <div
      ref={rootRef}
      // Focusable, so a click in the transcript keeps keys in the pane.
      tabIndex={-1}
      className="flex h-full w-full flex-col bg-neutral-950 text-[12.5px] text-neutral-300 outline-none"
      onKeyDown={(e) => {
        if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "f") {
          e.preventDefault();
          setFindQuery((q) => q ?? "");
          setFindFocus((n) => n + 1);
          return;
        }
        // ⌃C anywhere in the pane interrupts, as in the agents' TUIs.
        if (running && isInterruptKey(e)) {
          e.preventDefault();
          void cancel();
          return;
        }
        // 1–9 pick a pending permission's options, in order.
        const digit = pendingRequest ? digitShortcut(e) : null;
        const option = digit !== null ? pendingRequest?.options[digit - 1] : undefined;
        if (pendingRequest && option) {
          e.preventDefault();
          void answer(pendingRequest, option.id);
        }
      }}
    >
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-800 px-3 text-[11px]">
        <span
          className="min-w-0 truncate text-neutral-300"
          title={[
            "ACP transport",
            ...(t.ready
              ? [
                  `Agent session ${t.ready.sessionId}`,
                  t.ready.mcpAttached ? "treehouse MCP attached" : "No treehouse MCP",
                  ...(t.ready.cli ? [`CLI: ${t.ready.cli}`] : []),
                ]
              : []),
          ].join("\n")}
        >
          {t.title ?? t.ready?.agentName ?? "Agent"}
        </span>
        <span
          className="ml-auto flex min-w-0 max-w-[65%] items-center gap-1.5 text-neutral-500"
          title={[status.label, elapsed, activity].filter(Boolean).join(" · ")}
        >
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_TONE[status.tone])} />
          {!narrow && <span className="shrink-0">{status.label}</span>}
          {elapsed && (
            <span className="shrink-0 tabular-nums">
              {!narrow && "· "}
              {elapsed}
            </span>
          )}
          {activity && !narrow && (
            <span className="min-w-0 truncate font-mono text-neutral-400">· {activity}</span>
          )}
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
      {pinnedPrompt !== null && (
        <AcpPromptJumper prompts={prompts} current={pinnedPrompt} onJump={jumpToPrompt} />
      )}
      {findQuery !== null && (
        <AcpFindBar
          scrollRef={scrollRef}
          query={findQuery}
          onQuery={setFindQuery}
          focusNonce={findFocus}
          onClose={closeFind}
          onNavigate={() => (stickToBottom.current = false)}
        />
      )}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          measurePinned();
        }}
        className="h-full overflow-y-auto overflow-x-hidden"
      >
        <div
          className={cn(
            "mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-3",
            narrow ? "px-2.5 py-3" : "px-4 py-4",
          )}
        >
          {state.error && <ErrorRow message={state.error} />}
          {t.items.length === 0 && !state.error && (
            <div className="py-10 text-center text-[11px] text-neutral-600">
              {t.ready
                ? "Send a prompt to start."
                : state.sessionId
                  ? "Connecting to the agent…"
                  : "Starting the agent… The first ACP launch of a backend installs its adapter, which can take a minute."}
            </div>
          )}
          {groupItems(t.items).map((group) =>
            group.activity ? (
              <ActivityGroup
                key={group.start}
                items={group.items}
                // Runs before the latest prompt (or all, once idle) fold.
                settled={!running || group.start < lastPrompt}
              />
            ) : group.items[0].kind === "user" ? (
              // Prompts are anchors for the pinned header and its jumps.
              <div key={group.start} data-prompt={group.start} className="flex min-w-0 flex-col">
                <Row
                  item={group.items[0]}
                  pending={false}
                  onAnswer={answer}
                  onAnswerQuestion={answerQuestion}
                  onEdit={group.start === lastUser && canEdit ? editLast : undefined}
                />
              </div>
            ) : (
              <Row
                key={group.start}
                item={group.items[0]}
                pending={isPending(group.items[0], t.pendingPermission, t.pendingQuestion)}
                onAnswer={answer}
                onAnswerQuestion={answerQuestion}
                latest={group.start === lastTurnEnd}
              />
            ),
          )}
          {quiet && <ThinkingRow />}
        </div>
      </div>
      </div>

      {t.plan.length > 0 && <PlanList entries={t.plan} narrow={narrow} />}
      {t.followups.length > 0 && (
        <FollowupList
          followups={t.followups}
          narrow={narrow}
          onEdit={(f, i) => void unqueue(f, i)}
          onRemove={(f) => void unqueue(f, null)}
        />
      )}

      <AcpPromptBox
        worktreeId={worktreeId}
        commands={t.commands}
        controls={composerControls(t.config, t.modes)}
        usage={t.usage}
        onSetting={(p, v) => void setSetting(p, v)}
        canSend={!!state.sessionId}
        disabled={state.exited || !!state.error}
        running={running}
        imagesAllowed={t.ready?.acceptsImages ?? true}
        onSend={send}
        onCancel={() => void cancel()}
        focusNonce={focusNonce}
        history={history}
        editRequest={editRequest}
        insertRequest={insertRequest}
        restoreRequest={restoreRequest}
        requeueRequest={requeueRequest}
        narrow={narrow}
        stash={state.composer}
      />
    </div>
    </FindQueryContext.Provider>
    </WorktreeContext.Provider>
  );
}

type StatusTone = "busy" | "attention" | "ready" | "idle" | "error";
const STATUS_TONE: Record<StatusTone, string> = {
  busy: "bg-blue-400 animate-pulse",
  attention: "bg-amber-400",
  ready: "bg-emerald-400",
  idle: "bg-neutral-600",
  error: "bg-rose-400",
};

function isPending(item: AcpItem, permission: string | null, question: string | null): boolean {
  return (
    (item.kind === "permission" && item.request.id === permission) ||
    (item.kind === "question" && item.question.id === question)
  );
}

type ItemGroup = { start: number; activity: boolean; items: AcpItem[] };

/// Tool calls and the thoughts between them, which fold together. Leaving
/// plan mode carries the plan, so it stays out (always visible).
function isActivity(item: AcpItem): boolean {
  return item.kind === "thought" || (item.kind === "tool" && item.tool.kind !== "switch_mode");
}

/// Runs of activity group together; everything else stands alone. A run
/// with no tool call (a lone thought) stands alone too. `start` is the
/// first item's index, a stable key as items append.
function groupItems(items: AcpItem[]): ItemGroup[] {
  const groups: ItemGroup[] = [];
  items.forEach((item, i) => {
    const last = groups[groups.length - 1];
    const activity = isActivity(item);
    if (activity && last?.activity) last.items.push(item);
    else groups.push({ start: i, activity, items: [item] });
  });
  return groups.flatMap((g) =>
    g.activity && !g.items.some((it) => it.kind === "tool")
      ? g.items.map((item, j) => ({ start: g.start + j, activity: false, items: [item] }))
      : [g],
  );
}

/// Fold a settled run once it has this many tool calls.
const FOLD_MIN_TOOLS = 2;

/// A run of tool calls (and thoughts) as one quiet list. While the turn
/// works on it the rows show; once settled, it folds to a one-line summary
/// ("Read 9 files, ran 2 commands") that expands back.
function ActivityGroup({ items, settled }: { items: AcpItem[]; settled: boolean }) {
  const [open, setOpen] = useState(false);
  const tools = items.flatMap((it) => (it.kind === "tool" ? [it.tool] : []));
  const find = useContext(FindQueryContext);
  const found =
    !!find &&
    items.some((it) =>
      it.kind === "tool" ? toolMatches(it.tool, find) : it.kind === "thought" && it.text.toLowerCase().includes(find),
    );
  const rows = (
    <div className="flex min-w-0 flex-col">
      {items.map((item, j) =>
        item.kind === "tool" ? (
          <ToolRow key={j} tool={item.tool} />
        ) : item.kind === "thought" ? (
          <div key={j} className="py-[3px]">
            <Thought text={item.text} />
          </div>
        ) : null,
      )}
    </div>
  );
  if (!settled || tools.length < FOLD_MIN_TOOLS || found) return rows;
  let added = 0;
  let removed = 0;
  let edits = false;
  for (const tool of tools) {
    const s = diffStats(tool);
    if (!s) continue;
    edits = true;
    added += s.added;
    removed += s.removed;
  }
  const failed = tools.filter((t) => t.status === "failed").length;
  return (
    <div className="min-w-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group/fold -mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-[3px] text-left text-[11.5px] hover:bg-neutral-900"
      >
        <Layers size={12} className="shrink-0 text-neutral-500" />
        <span className="min-w-0 truncate text-neutral-400">{activitySummary(tools)}</span>
        {edits && <DiffCounts added={added} removed={removed} />}
        {failed > 0 && <span className="shrink-0 text-[10.5px] text-rose-400">{failed} failed</span>}
        <ChevronRight
          size={11}
          className={cn(
            "ml-auto shrink-0 text-neutral-500 transition",
            open ? "rotate-90" : "opacity-0 group-hover/fold:opacity-100",
          )}
        />
      </button>
      {open && <div className="mb-1 ml-[5px] mt-0.5 border-l border-neutral-800 pl-3.5">{rows}</div>}
    </div>
  );
}

/// Mid-turn, with nothing streaming or running: the agent is thinking.
function ThinkingRow() {
  return (
    <div className="flex items-center gap-2 text-[11px] text-neutral-500" role="status">
      <span className="flex gap-[3px]">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="h-1 w-1 animate-pulse rounded-full bg-neutral-500"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      Thinking…
    </div>
  );
}

const Row = memo(function Row({
  item,
  pending,
  onAnswer,
  onAnswerQuestion,
  onEdit,
  latest = false,
}: {
  item: AcpItem;
  pending: boolean;
  /// This is the transcript's last finished turn (its summary opens).
  latest?: boolean;
  /// Offered on the last sent prompt: load it into the composer to edit.
  onEdit?: (text: string) => void;
  onAnswer: (req: AcpPermissionRequest, optionId: string) => void;
  onAnswerQuestion: (
    q: AcpQuestion,
    action: "accept" | "decline",
    content?: Record<string, unknown>,
  ) => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="group/user flex max-w-[90%] flex-col items-end gap-1 self-end">
          {item.text && (
            <div className="flex items-start gap-1">
              {onEdit && (
                <button
                  onClick={() => onEdit(item.text)}
                  title="Edit and resend"
                  aria-label="Edit and resend"
                  className="mt-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 opacity-0 transition hover:bg-neutral-800 hover:text-neutral-100 focus:opacity-100 group-hover/user:opacity-100"
                >
                  <Pencil size={12} />
                </button>
              )}
              <div className="min-w-0 whitespace-pre-wrap rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-[13px] leading-relaxed text-neutral-100">
                {item.text}
              </div>
            </div>
          )}
          {item.attachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1">
              {item.attachments.map((a, i) => (
                <span
                  key={i}
                  className="flex h-5 max-w-[16rem] items-center gap-1 rounded-md bg-neutral-900 px-1.5 text-[10.5px] text-neutral-400"
                >
                  <Paperclip size={10} className="shrink-0 text-neutral-500" />
                  <span className="truncate font-mono">{a}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case "agent":
      return <AgentText text={item.text} />;
    case "thought":
      return <Thought text={item.text} />;
    case "tool":
      return <ToolRow tool={item.tool} />;
    case "permission":
      return <PermissionCard item={item} pending={pending} onAnswer={onAnswer} />;
    case "question":
      return <QuestionCard item={item} pending={pending} onAnswer={onAnswerQuestion} />;
    case "turnEnd": {
      const label = stopReasonLabel(item.stopReason);
      const changes = item.changes;
      if (!label && !changes?.length) return null;
      return (
        <div className="flex min-w-0 flex-col gap-1.5">
          {label && <div className="text-[11px] text-neutral-500">{label}</div>}
          {changes && changes.length > 0 && <TurnSummary changes={changes} defaultOpen={latest} />}
        </div>
      );
    }
    case "error":
      return <ErrorRow message={item.message} />;
  }
});

/// An agent reply. Hashes of commits the History tab lists link there.
function AgentText({ text }: { text: string }) {
  const ctx = useContext(WorktreeContext);
  const worktreeId = ctx?.worktreeId;
  const commits = useDiffsStore((s) =>
    worktreeId ? s.commitsByWorktree[worktreeId]?.commits : undefined,
  );
  const commitRefs = useMemo(
    () =>
      worktreeId && commits
        ? { commits, onOpen: (c: CommitSummary) => void openInHistory(worktreeId, c.sha) }
        : undefined,
    [worktreeId, commits],
  );
  return <ForgeMarkdown source={text} className="!text-[13px]" codeBlocks commitRefs={commitRefs} />;
}

function ErrorRow({ message }: { message: string }) {
  return (
    <div className="whitespace-pre-wrap rounded-md border border-rose-400/20 bg-rose-400/5 px-3 py-2 font-mono text-[11px] leading-relaxed text-rose-300">
      {message}
    </div>
  );
}

function Thought({ text }: { text: string }) {
  const [userOpen, setOpen] = useState(false);
  const find = useContext(FindQueryContext);
  const open = userOpen || (!!find && text.toLowerCase().includes(find));
  return (
    <div className="text-[11px] text-neutral-500">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 transition-colors hover:text-neutral-300"
      >
        <Brain size={12} />
        Thinking
        <ChevronRight size={11} className={cn("transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="ml-[5px] mt-1.5 whitespace-pre-wrap border-l border-neutral-800 pl-3.5 text-[12px] leading-relaxed">
          {text}
        </div>
      )}
    </div>
  );
}

const KIND_ICON: Record<string, LucideIcon> = {
  read: FileText,
  edit: Pencil,
  delete: Trash2,
  move: MoveRight,
  search: Search,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe,
  switch_mode: ListChecks,
};

/// Added / removed line counts across a tool call's diffs (a line diff of
/// each snippet), or null when it has none.
function diffStats(tool: AcpToolCall): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  let any = false;
  for (const c of tool.content) {
    if (c.kind !== "diff") continue;
    any = true;
    const s = lineDiffStats(c.oldText ?? "", c.newText);
    added += s.added;
    removed += s.removed;
  }
  return any ? { added, removed } : null;
}

/// One tool call as a quiet row: kind icon (a spinner while it runs),
/// title, edit counts. Click to expand what it did.
function ToolRow({ tool }: { tool: AcpToolCall }) {
  const [userOpen, setOpen] = useState(false);
  const find = useContext(FindQueryContext);
  // Opened by a find hit in its body (the title is always on screen).
  const found = !!find && toolMatches(tool, find, false);
  const open = userOpen || found;
  const hasBody = toolHasBody(tool);
  const target = primaryTarget(tool);
  const stats = diffStats(tool);
  const running = isToolRunning(tool);
  const failed = tool.status === "failed";
  const Icon = running ? Loader2 : (KIND_ICON[tool.kind] ?? Wrench);
  return (
    <div className="group/tool min-w-0">
      <button
        onClick={() => hasBody && setOpen((o) => !o)}
        title={tool.name ?? undefined}
        className={cn(
          "-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-[3px] text-left",
          hasBody ? "hover:bg-neutral-900" : "cursor-default",
        )}
      >
        <Icon
          size={12}
          className={cn(
            "shrink-0",
            running ? "animate-spin text-blue-400" : failed ? "text-rose-400" : "text-neutral-500",
          )}
        />
        <span
          className={cn(
            "min-w-0 truncate font-mono text-[11.5px]",
            failed ? "text-neutral-500" : "text-neutral-300",
          )}
        >
          {toolTitle(tool)}
        </span>
        {stats && <DiffCounts added={stats.added} removed={stats.removed} />}
        {failed && <span className="shrink-0 text-[10.5px] text-rose-400">failed</span>}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {target && <OpenFileButton target={target} />}
          {hasBody && (
            <ChevronRight
              size={11}
              className={cn(
                "text-neutral-500 transition",
                open ? "rotate-90" : "opacity-0 group-hover/tool:opacity-100",
              )}
            />
          )}
        </span>
      </button>
      {open && (
        <div className="mb-2 ml-[5px] mt-1 border-l border-neutral-800 pl-3.5">
          <ToolBody tool={tool} full={found} />
        </div>
      )}
    </div>
  );
}

/// The text a tool row shows when open (and, with `title`, folded), for
/// find: its command, output, diffs, paths, or raw input.
function toolMatches(tool: AcpToolCall, query: string, title = true): boolean {
  const parts = [
    ...(title ? [toolTitle(tool)] : []),
    commandOf(tool) ?? "",
    ...tool.locations.map((l) => l.path),
    ...tool.content.map((c) =>
      c.kind === "text" ? c.text : c.kind === "diff" ? `${c.path}\n${c.oldText ?? ""}\n${c.newText}` : "",
    ),
    tool.content.length === 0 ? (tool.rawInput ?? "") : "",
  ];
  return parts.some((p) => p.toLowerCase().includes(query));
}

/// A tool's display title: the agent's (minus wrapping backticks), else
/// its name or kind.
function toolTitle(tool: AcpToolCall): string {
  const t = tool.title.trim().replace(/^`([^`]*)`$/, "$1");
  return t || tool.name || tool.kind;
}

/// A file a tool call touches, and how to find the spot in it: a line the
/// agent gave, or an edit's text to search for.
type FileTarget = { path: string; line: number | null; newText?: string; oldText?: string | null };

/// The file a tool card's open button goes to: its first edit, else its
/// first location.
function primaryTarget(tool: AcpToolCall): FileTarget | null {
  const diff = tool.content.find((c) => c.kind === "diff");
  if (diff && diff.kind === "diff") {
    const loc = tool.locations.find((l) => l.path === diff.path);
    return { path: diff.path, line: loc?.line ?? null, newText: diff.newText, oldText: diff.oldText };
  }
  const loc = tool.locations[0];
  return loc ? { path: loc.path, line: loc.line } : null;
}

/// `target.path` relative to the worktree, or null when it's outside.
function relativeTo(root: string, path: string): string | null {
  if (!root) return null;
  const base = root.endsWith("/") ? root : `${root}/`;
  if (path.startsWith(base)) return path.slice(base.length);
  return path.startsWith("/") ? null : path;
}

/// Open a target in the editor. Without a line, an edit's position is
/// found by searching the file for its new text (applied) or old text
/// (still pending, e.g. awaiting permission).
async function openTarget(worktreeId: WorktreeId, rel: string, target: FileTarget) {
  let line = target.line;
  if (line === null && target.newText !== undefined) {
    const file = await readFile(worktreeId, rel).catch(() => null);
    const text = file?.text ?? "";
    line =
      lineOfSnippet(text, target.newText) ??
      (target.oldText ? lineOfSnippet(text, target.oldText) : null);
  }
  await openWorktreeFile(worktreeId, rel, line);
}

function useOpenTarget(target: FileTarget): { rel: string | null; open: () => void } {
  const ctx = useContext(WorktreeContext);
  const rel = ctx ? relativeTo(ctx.root, target.path) : null;
  return {
    rel,
    open: () => {
      if (ctx && rel !== null) void openTarget(ctx.worktreeId, rel, target);
    },
  };
}

function OpenFileButton({ target }: { target: FileTarget }) {
  const { rel, open } = useOpenTarget(target);
  if (rel === null) return null;
  return (
    <span
      role="button"
      tabIndex={0}
      title={`Open ${rel} in the editor`}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.stopPropagation();
          open();
        }
      }}
      className="flex h-4 w-4 items-center justify-center rounded text-neutral-500 opacity-0 transition hover:bg-neutral-800 hover:text-neutral-100 focus:opacity-100 group-hover/tool:opacity-100"
    >
      <ArrowUpRight size={11} />
    </span>
  );
}

/// A path that opens in the editor when it's inside the worktree; shown
/// worktree-relative, with `:line` when known.
function FileLink({ target }: { target: FileTarget }) {
  const { rel, open } = useOpenTarget(target);
  const label = `${rel ?? target.path}${target.line ? `:${target.line}` : ""}`;
  if (rel === null) {
    return (
      <div
        className="truncate font-mono text-[11px] text-neutral-500"
        title={`${target.path} (outside this worktree)`}
      >
        {label}
      </div>
    );
  }
  return (
    <button
      onClick={open}
      title="Open in the editor"
      className="block max-w-full truncate text-left font-mono text-[11px] text-blue-400 hover:underline"
    >
      {label}
    </button>
  );
}

function toolHasBody(tool: AcpToolCall): boolean {
  return tool.content.length > 0 || tool.locations.length > 0 || !!tool.rawInput;
}

/// What a tool call does / did: its command, diffs (highlighted as diffs),
/// output, or — when the agent sent no content — its raw input.
/// Long code collapses past this many lines (see `CodeBlock`).
const BODY_MAX_LINES = 16;

function ToolBody({ tool, full = false }: { tool: AcpToolCall; full?: boolean }) {
  const command = commandOf(tool);
  // `full`: a find hit may be past the collapse.
  const maxLines = full ? undefined : BODY_MAX_LINES;
  // Plans (leaving plan mode) and reasoning come as prose, not code.
  const prose = tool.kind === "switch_mode" || tool.kind === "think";
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {tool.locations
        .filter((l) => !tool.content.some((c) => c.kind === "diff" && c.path === l.path))
        .map((l) => (
          <FileLink key={`${l.path}:${l.line}`} target={{ path: l.path, line: l.line }} />
        ))}
      {command && <CodeBlock code={command} lang="bash" maxLines={maxLines} compact />}
      {tool.content.map((c, i) =>
        c.kind === "text" ? (
          prose ? (
            <ForgeMarkdown key={i} source={c.text} codeBlocks />
          ) : (
            <CodeBlock key={i} code={c.text} maxLines={maxLines} compact />
          )
        ) : c.kind === "diff" ? (
          <div key={i} className="flex min-w-0 flex-col gap-1">
            <FileLink
              target={{
                path: c.path,
                line: tool.locations.find((l) => l.path === c.path)?.line ?? null,
                newText: c.newText,
                oldText: c.oldText,
              }}
            />
            {c.oldText ? (
              <CodeBlock code={diffText(c.oldText, c.newText)} lang="diff" maxLines={maxLines} compact />
            ) : (
              // A new file: its own language reads better than all-`+`.
              <CodeBlock code={c.newText} lang={langForPath(c.path)} maxLines={maxLines} compact />
            )}
          </div>
        ) : (
          <div key={i} className="text-[11px] text-neutral-500">
            Agent terminal {c.terminalId}
          </div>
        ),
      )}
      {tool.content.length === 0 && !command && tool.rawInput && (
        <CodeBlock code={tool.rawInput} lang="json" maxLines={maxLines} compact />
      )}
    </div>
  );
}

/// The card chrome shared by permission requests and questions while they
/// wait on the user: the app's raised surface with a colored rail.
function PendingCard({
  rail,
  icon: Icon,
  iconClass,
  heading,
  children,
}: {
  rail: string;
  icon: LucideIcon;
  iconClass: string;
  heading: React.ReactNode;
  children: React.ReactNode;
}) {
  // No overflow-hidden: it would break the sticky footer inside.
  return (
    <div className="relative min-w-0 rounded-md border border-neutral-800 bg-neutral-900 pl-3.5 pr-3 pt-2.5">
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[2px] rounded-l-md", rail)} />
      <div className="mb-2 flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-neutral-100">
        <Icon size={13} className={cn("shrink-0", iconClass)} />
        {heading}
      </div>
      {children}
    </div>
  );
}

/// Footer for a pending card. Sticky to the transcript's bottom edge, so a
/// long card can't push its answer out of view.
function PendingActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 -ml-3.5 -mr-3 mt-2.5 flex flex-wrap items-center gap-1.5 rounded-b-md border-t border-neutral-800 bg-neutral-900 py-2 pl-3.5 pr-3">
      {children}
    </div>
  );
}

const primaryButton =
  "flex h-6 items-center rounded-md bg-blue-600 px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-blue-600";
const secondaryButton =
  "flex h-6 items-center rounded-md border border-neutral-700 px-2 text-[11px] text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100";
const ghostButton =
  "flex h-6 items-center rounded-md px-2 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100";

/// An answered permission or question, folded to one quiet line like a
/// tool row, optionally expandable.
function ResolvedRow({
  icon: Icon,
  label,
  outcome,
  children,
}: {
  icon: LucideIcon;
  label: string;
  outcome: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="group/tool min-w-0">
      <button
        onClick={() => children && setOpen((o) => !o)}
        className={cn(
          "-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-[3px] text-left text-[11.5px]",
          children ? "hover:bg-neutral-900" : "cursor-default",
        )}
      >
        <Icon size={12} className="shrink-0 text-neutral-500" />
        <span className="min-w-0 truncate text-neutral-400">{label}</span>
        <span className="shrink-0 text-neutral-500">{outcome}</span>
        {children && (
          <ChevronRight
            size={11}
            className={cn(
              "ml-auto shrink-0 text-neutral-500 transition",
              open ? "rotate-90" : "opacity-0 group-hover/tool:opacity-100",
            )}
          />
        )}
      </button>
      {open && <div className="mb-2 ml-[5px] mt-1 border-l border-neutral-800 pl-3.5">{children}</div>}
    </div>
  );
}

function PermissionCard({
  item,
  pending,
  onAnswer,
}: {
  item: Extract<AcpItem, { kind: "permission" }>;
  pending: boolean;
  onAnswer: (req: AcpPermissionRequest, optionId: string) => void;
}) {
  const { request, resolved } = item;
  const hasBody = toolHasBody(request.tool);
  if (!pending) {
    const chosen = resolved && request.options.find((o) => o.id === resolved.optionId);
    const allowed = chosen && chosen.kind.startsWith("allow");
    return (
      <ResolvedRow
        icon={allowed ? ShieldCheck : ShieldX}
        label={request.title}
        outcome={resolved ? (chosen ? `→ ${chosen.name}` : "Cancelled") : "No longer pending"}
      >
        {hasBody ? <ToolBody tool={request.tool} /> : undefined}
      </ResolvedRow>
    );
  }
  return (
    <PendingCard
      rail="bg-amber-400"
      icon={ShieldAlert}
      iconClass="text-amber-400"
      heading={
        <span className="min-w-0 truncate">
          Allow {request.tool.name ? <span className="font-mono">{request.tool.name}</span> : "this action"}?
        </span>
      }
    >
      <div className="mb-2 break-words font-mono text-[11.5px] text-neutral-300">{request.title}</div>
      {hasBody && <ToolBody tool={request.tool} />}
      <PendingActions>
        {request.options.map((o, i) => (
          <button
            key={o.id}
            onClick={() => onAnswer(request, o.id)}
            title={i < 9 ? `${o.name} (${i + 1})` : undefined}
            className={cn(
              "gap-1.5",
              o.kind === "allow_once"
                ? primaryButton
                : o.kind.startsWith("allow")
                  ? secondaryButton
                  : ghostButton,
            )}
          >
            {i < 9 && (
              <kbd className="font-mono text-[10px] opacity-60" aria-hidden>
                {i + 1}
              </kbd>
            )}
            {o.name}
          </button>
        ))}
      </PendingActions>
    </PendingCard>
  );
}

/// A question the agent asked (a form): choices as selectable rows, free
/// text, toggles. Submit sends the filled fields; Skip declines.
function QuestionCard({
  item,
  pending,
  onAnswer,
}: {
  item: Extract<AcpItem, { kind: "question" }>;
  pending: boolean;
  onAnswer: (q: AcpQuestion, action: "accept" | "decline", content?: Record<string, unknown>) => void;
}) {
  const { question, resolved } = item;
  const [values, setValues] = useState<Record<string, FormValue>>({});
  const set = (key: string, v: FormValue) => setValues((prev) => ({ ...prev, [key]: v }));
  const ready = canSubmitAnswer(question.fields, values);
  if (!pending) {
    return (
      <ResolvedRow
        icon={MessageCircleQuestion}
        label={questionLabel(question)}
        outcome={
          resolved?.action === "accept"
            ? `→ ${resolved.summary ?? "Answered"}`
            : resolved?.action === "decline"
              ? "Skipped"
              : resolved
                ? "Cancelled"
                : "No longer pending"
        }
      />
    );
  }
  return (
    <PendingCard rail="bg-blue-400" icon={MessageCircleQuestion} iconClass="text-blue-400" heading="Question">
      {question.message && (
        <ForgeMarkdown source={question.message} className="mb-3 !text-[13px] text-neutral-100" />
      )}
      <div className="flex flex-col gap-3.5">
        {question.fields.map((f) => (
          <FormFieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
        ))}
      </div>
      <PendingActions>
        <button
          onClick={() => onAnswer(question, "accept", questionAnswer(question.fields, values))}
          disabled={!ready}
          className={primaryButton}
        >
          Submit
        </button>
        <button onClick={() => onAnswer(question, "decline")} className={ghostButton}>
          Skip
        </button>
      </PendingActions>
    </PendingCard>
  );
}

/// One line naming an answered question: its first field's prompt (the
/// adapter's message is often generic), else the message.
function questionLabel(q: AcpQuestion): string {
  const f = q.fields[0];
  return f?.description ?? f?.title ?? (q.message || "Question");
}

const fieldInput =
  "w-full rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-[12px] text-neutral-100 placeholder:text-neutral-600 transition-colors focus:border-blue-500/60 focus:outline-none focus:ring-1 focus:ring-blue-500/30";

function FormFieldInput({
  field,
  value,
  onChange,
}: {
  field: AcpFormField;
  value: FormValue | undefined;
  onChange: (v: FormValue) => void;
}) {
  const { input } = field;
  const label = (field.title || field.description) && (
    <div className="mb-1.5">
      {field.title && (
        <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-neutral-500">
          {field.title}
          {field.required && <span className="text-neutral-600"> · required</span>}
        </div>
      )}
      {field.description && (
        <div className="mt-0.5 text-[12.5px] leading-snug text-neutral-200">{field.description}</div>
      )}
    </div>
  );
  if (input.kind === "choice") {
    const picked = input.multi ? ((value as string[] | undefined) ?? []) : value;
    const isOn = (v: string) => (input.multi ? (picked as string[]).includes(v) : picked === v);
    const selected = input.options.find((o) => isOn(o.value) && o.preview);
    return (
      <div>
        {label}
        <div className="flex flex-col gap-1" role={input.multi ? "group" : "radiogroup"}>
          {input.options.map((o) => {
            const on = isOn(o.value);
            return (
              <button
                key={o.value}
                role={input.multi ? "checkbox" : "radio"}
                aria-checked={on}
                onClick={() => {
                  if (!input.multi) return onChange(on ? "" : o.value);
                  const cur = picked as string[];
                  onChange(on ? cur.filter((x) => x !== o.value) : [...cur, o.value]);
                }}
                className={cn(
                  "flex items-start gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                  on
                    ? "border-blue-500/50 bg-blue-500/10"
                    : "border-neutral-800 bg-neutral-950 hover:border-neutral-700",
                )}
              >
                <span
                  className={cn(
                    "mt-[3px] flex h-3 w-3 shrink-0 items-center justify-center border transition-colors",
                    input.multi ? "rounded-[3px]" : "rounded-full",
                    on ? "border-blue-400 bg-blue-500 text-white" : "border-neutral-600",
                  )}
                >
                  {on &&
                    (input.multi ? (
                      <Check size={9} strokeWidth={3} />
                    ) : (
                      <span className="h-1 w-1 rounded-full bg-white" />
                    ))}
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] text-neutral-100">{o.title}</span>
                  {o.description && (
                    <span className="block text-[11px] leading-snug text-neutral-500">{o.description}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        {selected?.preview && <CodeBlock code={selected.preview} className="mt-1.5" maxLines={12} compact />}
      </div>
    );
  }
  if (input.kind === "boolean") {
    return (
      <label className="flex cursor-pointer items-center gap-2 text-[12px] text-neutral-200">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-blue-500"
        />
        {field.title ?? field.key}
        {field.description && <span className="text-neutral-500">— {field.description}</span>}
      </label>
    );
  }
  const common = {
    value: typeof value === "string" ? value : "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    placeholder: field.title === "Other" ? "Or type your own answer" : (field.title ?? ""),
    spellCheck: false,
    className: fieldInput,
  };
  return (
    <div>
      {field.title !== "Other" && label}
      {input.kind === "text" && input.multiline ? (
        <textarea rows={1} {...common} className={cn(fieldInput, "resize-y")} />
      ) : (
        <input type={input.kind === "number" ? "number" : "text"} {...common} />
      )}
    </div>
  );
}

const PLAN_ICON: Record<string, { icon: LucideIcon; className: string }> = {
  completed: { icon: CircleCheck, className: "text-emerald-400/80" },
  in_progress: { icon: CircleDot, className: "text-blue-400" },
};

/// The agent's plan, docked above the composer: a one-line summary that
/// expands to the checklist.
function PlanList({ entries, narrow }: { entries: AcpPlanEntry[]; narrow: boolean }) {
  const [open, setOpen] = useState(true);
  const done = entries.filter((e) => e.status === "completed").length;
  const current = entries.find((e) => e.status === "in_progress");
  return (
    <div className={cn("mx-auto w-full max-w-3xl shrink-0 pb-1.5", narrow ? "px-2" : "px-3")}>
      <div className="rounded-md border border-neutral-800 bg-neutral-900/60">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px]"
        >
          <ListChecks size={12} className="shrink-0 text-neutral-500" />
          <span className="font-medium text-neutral-300">Plan</span>
          <span className="tabular-nums text-neutral-500">
            {done}/{entries.length}
          </span>
          {!open && current && <span className="min-w-0 truncate text-neutral-400">{current.content}</span>}
          <ChevronDown
            size={12}
            className={cn("ml-auto shrink-0 text-neutral-500 transition-transform", !open && "rotate-180")}
          />
        </button>
        {open && (
          <div className="max-h-36 overflow-y-auto px-3 pb-2">
            {entries.map((e, i) => {
              const { icon: Icon, className } = PLAN_ICON[e.status] ?? {
                icon: Circle,
                className: "text-neutral-600",
              };
              return (
                <div key={i} className="flex items-start gap-2 py-[2px] text-[11.5px] leading-snug">
                  <Icon size={12} className={cn("mt-[1px] shrink-0", className)} />
                  <span
                    className={cn(
                      e.status === "completed"
                        ? "text-neutral-500"
                        : e.status === "in_progress"
                          ? "text-neutral-100"
                          : "text-neutral-400",
                    )}
                  >
                    {e.content}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/// Prompts held for after the running turn, docked above the composer:
/// each can be taken back to edit, or dropped.
function FollowupList({
  followups,
  narrow,
  onEdit,
  onRemove,
}: {
  followups: AcpFollowup[];
  narrow: boolean;
  /// `i`: its place in the queue, to go back to.
  onEdit: (f: AcpFollowup, i: number) => void;
  onRemove: (f: AcpFollowup) => void;
}) {
  return (
    <div
      className={cn("mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-1 pb-1.5", narrow ? "px-2" : "px-3")}
      aria-label="Queued prompts"
    >
      {followups.map((f, i) => {
        const files = f.attachments.length;
        return (
          <div
            key={f.id}
            className="group/queued flex min-w-0 items-center gap-2 rounded-md border border-dashed border-neutral-800 bg-neutral-900/40 px-2.5 py-1 text-[11.5px]"
          >
            <span className="shrink-0 text-[10.5px] uppercase tracking-[0.08em] text-neutral-500">
              {i === 0 ? "Next" : "Queued"}
            </span>
            <span className="min-w-0 flex-1 truncate text-neutral-300" title={f.text}>
              {promptLabel(f.text, f.attachments.map((a) => (a.kind === "file" ? a.path : "image")))}
            </span>
            {files > 0 && f.text.trim() && (
              <span className="flex shrink-0 items-center gap-0.5 text-[10.5px] text-neutral-500">
                <Paperclip size={10} />
                {files}
              </span>
            )}
            <span className="flex shrink-0 items-center gap-0.5">
              <button
                onClick={() => onEdit(f, i)}
                title="Edit (it keeps its place in the queue)"
                aria-label="Edit queued prompt"
                className="flex h-5 w-5 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-100"
              >
                <Pencil size={11} />
              </button>
              <button
                onClick={() => onRemove(f)}
                title="Remove from the queue"
                aria-label="Remove queued prompt"
                className="flex h-5 w-5 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-100"
              >
                <X size={11} />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/// Show this many files before "Show N more".
const SUMMARY_FILES = 6;

/// A finished turn's changed files (measured from git, so shell edits
/// count) with line counts. Each opens in the diff pane; the latest turn's
/// starts open, earlier ones fold to one line.
function TurnSummary({ changes, defaultOpen }: { changes: TurnFileChange[]; defaultOpen: boolean }) {
  const ctx = useContext(WorktreeContext);
  const [open, setOpen] = useState(defaultOpen);
  const [all, setAll] = useState(false);
  // A newer turn finishing folds this one away.
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  // Paths are repo-relative, and the worktree is the repo.
  const rows = changes.map((c) => ({ ...c, rel: ctx?.root ? c.path : null }));
  const added = changes.reduce((n, c) => n + c.added, 0);
  const removed = changes.reduce((n, c) => n + c.removed, 0);
  const firstRel = rows.find((r) => r.rel !== null)?.rel ?? null;
  const shown = all ? rows : rows.slice(0, SUMMARY_FILES);
  return (
    <div className="min-w-0 rounded-md border border-neutral-800 bg-neutral-900/60">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[11.5px]">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 items-center gap-2 text-left"
          aria-expanded={open}
        >
          <FileDiff size={12} className="shrink-0 text-neutral-500" />
          <span className="truncate text-neutral-300">
            {changes.length} file{changes.length === 1 ? "" : "s"} changed
          </span>
          <DiffCounts added={added} removed={removed} />
          <ChevronRight
            size={11}
            className={cn("shrink-0 text-neutral-500 transition-transform", open && "rotate-90")}
          />
        </button>
        {ctx && firstRel !== null && (
          <button
            onClick={() => openInDiff(ctx.worktreeId, firstRel)}
            title="Open these changes in the diff"
            className="ml-auto flex h-5 shrink-0 items-center rounded px-1.5 text-[11px] text-blue-400 transition-colors hover:bg-neutral-800"
          >
            Review
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-neutral-800 py-1">
          {shown.map((r) => (
            <ChangeRow key={r.path} change={r} rel={r.rel} worktreeId={ctx?.worktreeId ?? null} />
          ))}
          {rows.length > SUMMARY_FILES && (
            <button
              onClick={() => setAll((a) => !a)}
              className="px-2.5 py-0.5 text-[11px] text-neutral-500 hover:text-neutral-300"
            >
              {all ? "Show fewer" : `Show ${rows.length - SUMMARY_FILES} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const CHANGE_MARK: Record<string, { mark: string; className: string; label: string }> = {
  added: { mark: "A", className: "text-emerald-400/80", label: "Added" },
  modified: { mark: "M", className: "text-neutral-500", label: "Modified" },
  deleted: { mark: "D", className: "text-rose-400/80", label: "Deleted" },
};

function ChangeRow({
  change,
  rel,
  worktreeId,
}: {
  change: TurnFileChange;
  rel: string | null;
  worktreeId: WorktreeId | null;
}) {
  const shown = rel ?? change.path;
  const slash = shown.lastIndexOf("/");
  const mark = CHANGE_MARK[change.status] ?? CHANGE_MARK.modified;
  const body = (
    <>
      <span className={cn("w-3 shrink-0 font-mono text-[10.5px]", mark.className)} title={mark.label}>
        {mark.mark}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
        {slash >= 0 && <span className="text-neutral-500">{shown.slice(0, slash + 1)}</span>}
        <span className={rel !== null ? "text-neutral-200" : "text-neutral-400"}>{shown.slice(slash + 1)}</span>
      </span>
      {change.binary ? (
        <span className="shrink-0 text-[10.5px] text-neutral-500">binary</span>
      ) : (
        <DiffCounts added={change.added} removed={change.removed} />
      )}
    </>
  );
  if (rel === null || worktreeId === null) {
    return (
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-[3px]" title={`${change.path} (outside this worktree)`}>
        {body}
      </div>
    );
  }
  return (
    <button
      onClick={() => openInDiff(worktreeId, rel)}
      title={`Open ${rel} in the diff`}
      className="flex w-full min-w-0 items-center gap-2 px-2.5 py-[3px] text-left hover:bg-neutral-800/60"
    >
      {body}
    </button>
  );
}

function DiffCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
      <span className="text-emerald-400/80">+{added}</span>{" "}
      <span className="text-rose-400/80">−{removed}</span>
    </span>
  );
}

/// Open commit `sha` in the History tab, its diff in the main pane.
async function openInHistory(worktreeId: WorktreeId, sha: string) {
  const ui = useUiStore.getState();
  ui.setDiffSidebarTab("history");
  if (ui.bottomPaneMaximized) useUiStore.setState({ bottomPaneMaximized: false });
  const diffs = useDiffsStore.getState();
  await diffs.selectCommit(worktreeId, sha);
  if (useDiffsStore.getState().selectedCommit[worktreeId] === sha) diffs.setView(worktreeId, "diff");
}

/// Show `rel` in the diff pane: the branch's changes (what merge-back
/// ships), with the Changes list beside it, and the diff not hidden behind
/// a maximized bottom pane.
function openInDiff(worktreeId: WorktreeId, rel: string) {
  const ui = useUiStore.getState();
  ui.setDiffSidebarTab("changes");
  if (ui.bottomPaneMaximized) useUiStore.setState({ bottomPaneMaximized: false });
  const diffs = useDiffsStore.getState();
  diffs.selectFile(worktreeId, rel, "branch");
  diffs.setView(worktreeId, "diff");
}
