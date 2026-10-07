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
import { ArrowUpRight, ChevronRight } from "lucide-react";

import {
  acpAnswerQuestion,
  acpCancel,
  acpRespondPermission,
  acpSendPrompt,
  acpSetConfig,
  acpSetMode,
  readFile,
} from "@/ipc/client";
import type {
  AcpAttachment,
  AcpFormField,
  AcpPermissionRequest,
  AcpPlanEntry,
  AcpQuestion,
  AcpToolCall,
  AgentSessionId,
  WorktreeId,
} from "@/ipc/types";
import { ForgeMarkdown } from "@/components/ForgeMarkdown";
import { CodeBlock, langForPath } from "@/components/CodeBlock";
import { cn } from "@/lib/cn";
import { asMessage } from "@/lib/errors";
import {
  canSubmitAnswer,
  commandOf,
  diffText,
  lineOfSnippet,
  questionAnswer,
  stopReasonLabel,
  type AcpItem,
  type FormValue,
} from "@/lib/acp-transcript";
import { useWorktreesStore } from "@/stores/worktrees";
import { openWorktreeFile } from "./term-path-links";
import { useToastsStore } from "@/stores/toasts";
import { createAcpLeafState, type AcpLeafState } from "./acp-leaf-state";
import { AcpPromptBox } from "./AcpPromptBox";
import { composerControls, type ComposerPicker } from "@/lib/acp-composer";
import type { AgentLeafMode } from "./agent-leaf-state";

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
}: {
  worktreeId: WorktreeId;
  mode: AgentLeafMode;
  poolKey: string;
  visible: boolean;
  leafStates: Map<string, AcpLeafState>;
  onSession: (id: AgentSessionId) => void;
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
  const worktreeCtx = useMemo(() => ({ worktreeId, root }), [worktreeId, root]);
  const t = state.transcript;
  const running = t.turns > 0 && !state.exited;

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  });

  const [focusNonce, setFocusNonce] = useState(0);
  useEffect(() => {
    if (visible) setFocusNonce((n) => n + 1);
  }, [visible]);

  function reportError(title: string, e: unknown) {
    useToastsStore.getState().push({ kind: "error", title, body: asMessage(e) });
  }

  async function send(text: string, attachments: AcpAttachment[]): Promise<boolean> {
    if (!state.sessionId || state.exited) return false;
    stickToBottom.current = true;
    try {
      await acpSendPrompt(state.sessionId, text, attachments);
      return true;
    } catch (e) {
      reportError("Couldn't send prompt", e);
      return false;
    }
  }

  async function cancel() {
    if (!state.sessionId) return;
    await acpCancel(state.sessionId).catch((e) => reportError("Couldn't cancel", e));
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

  const status = state.error
    ? "Failed to start"
    : state.exited
      ? "Exited"
      : !t.ready
        ? "Starting adapter…"
        : t.pendingPermission
          ? "Waiting for permission"
          : running
            ? "Working…"
            : "Ready";

  return (
    <WorktreeContext.Provider value={worktreeCtx}>
    <div className="flex h-full w-full flex-col text-[12.5px] text-neutral-300">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-800 px-3 text-[11px] text-neutral-500">
        <span className="rounded border border-neutral-700 px-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
          ACP
        </span>
        <span className="truncate text-neutral-300">{t.title ?? t.ready?.agentName ?? "Agent"}</span>
        <span className={cn("ml-auto shrink-0", t.pendingPermission && "text-amber-400")}>
          {status}
        </span>
        {t.ready && (
          <span
            className="shrink-0 cursor-default font-mono text-neutral-600"
            title={[
              `Agent session ${t.ready.sessionId}`,
              t.ready.mcpAttached ? "treehouse MCP attached" : "no treehouse MCP",
              ...(t.ready.cli ? [`CLI: ${t.ready.cli}`] : []),
            ].join("\n")}
          >
            {t.ready.sessionId.slice(0, 8)}
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-2"
      >
        {state.error && <ErrorRow message={state.error} />}
        {t.items.length === 0 && !state.error && (
          <div className="py-6 text-center text-xs text-neutral-600">
            {t.ready
              ? "Send a prompt to start."
              : state.sessionId
                ? "Connecting to the agent…"
                : "Starting the agent… (a backend's first ACP launch installs its adapter, which can take a minute)"}
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-2">
          {t.items.map((item, i) => (
            <Row
              key={i}
              item={item}
              pending={
                (item.kind === "permission" && item.request.id === t.pendingPermission) ||
                (item.kind === "question" && item.question.id === t.pendingQuestion)
              }
              onAnswer={answer}
              onAnswerQuestion={answerQuestion}
            />
          ))}
        </div>
      </div>

      {t.plan.length > 0 && <PlanList entries={t.plan} />}

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
      />
    </div>
    </WorktreeContext.Provider>
  );
}

const Row = memo(function Row({
  item,
  pending,
  onAnswer,
  onAnswerQuestion,
}: {
  item: AcpItem;
  pending: boolean;
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
        <div className="flex max-w-[90%] flex-col items-end gap-1 self-end">
          {item.text && (
            <div className="whitespace-pre-wrap rounded-md bg-neutral-800 px-2.5 py-1.5 text-neutral-100">
              {item.text}
            </div>
          )}
          {item.attachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1">
              {item.attachments.map((a, i) => (
                <span
                  key={i}
                  className="rounded border border-neutral-700 px-1 font-mono text-[10.5px] text-neutral-400"
                >
                  {a}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case "agent":
      return <ForgeMarkdown source={item.text} className="text-[12.5px]" codeBlocks />;
    case "thought":
      return <Thought text={item.text} />;
    case "tool":
      return <ToolCard tool={item.tool} />;
    case "permission":
      return <PermissionCard item={item} pending={pending} onAnswer={onAnswer} />;
    case "question":
      return <QuestionCard item={item} pending={pending} onAnswer={onAnswerQuestion} />;
    case "turnEnd": {
      const label = stopReasonLabel(item.stopReason);
      return label ? <div className="text-[11px] italic text-neutral-500">{label}</div> : null;
    }
    case "error":
      return <ErrorRow message={item.message} />;
  }
});

function ErrorRow({ message }: { message: string }) {
  return (
    <div className="whitespace-pre-wrap rounded border border-red-900/60 bg-red-950/40 px-2.5 py-1.5 font-mono text-[11px] text-red-300">
      {message}
    </div>
  );
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[11.5px] text-neutral-500">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 hover:text-neutral-300">
        <ChevronRight size={11} className={cn("transition-transform", open && "rotate-90")} />
        Thinking
      </button>
      {open && <div className="mt-1 whitespace-pre-wrap border-l border-neutral-800 pl-2 italic">{text}</div>}
    </div>
  );
}

const STATUS_DOT: Record<string, string> = {
  pending: "bg-neutral-500",
  in_progress: "bg-blue-400 animate-pulse",
  completed: "bg-emerald-500",
  failed: "bg-red-500",
};

function ToolCard({ tool }: { tool: AcpToolCall }) {
  const [open, setOpen] = useState(false);
  const hasBody = toolHasBody(tool);
  const target = primaryTarget(tool);
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/60">
      <button
        onClick={() => hasBody && setOpen((o) => !o)}
        className={cn("flex w-full items-center gap-2 px-2 py-1 text-left", hasBody && "hover:bg-neutral-800/60")}
      >
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[tool.status] ?? "bg-neutral-500")} />
        {tool.name && <span className="shrink-0 text-[11px] text-neutral-500">{tool.name}</span>}
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-neutral-300">
          {tool.title || tool.kind}
        </span>
        {target && <OpenFileButton target={target} />}
        {hasBody && (
          <ChevronRight size={11} className={cn("shrink-0 text-neutral-500 transition-transform", open && "rotate-90")} />
        )}
      </button>
      {open && (
        <div className="border-t border-neutral-800 px-2 py-1.5">
          <ToolBody tool={tool} />
        </div>
      )}
    </div>
  );
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
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100"
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
      <div className="truncate font-mono text-neutral-500" title={`${target.path} (outside this worktree)`}>
        {label}
      </div>
    );
  }
  return (
    <button
      onClick={open}
      title="Open in the editor"
      className="block max-w-full truncate text-left font-mono text-neutral-400 underline-offset-2 hover:text-blue-300 hover:underline"
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

function ToolBody({ tool }: { tool: AcpToolCall }) {
  const command = commandOf(tool);
  // Plans (leaving plan mode) and reasoning come as prose, not code.
  const prose = tool.kind === "switch_mode" || tool.kind === "think";
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-[11px]">
      {tool.locations
        .filter((l) => !tool.content.some((c) => c.kind === "diff" && c.path === l.path))
        .map((l) => (
          <FileLink key={`${l.path}:${l.line}`} target={{ path: l.path, line: l.line }} />
        ))}
      {command && <CodeBlock code={command} lang="bash" maxLines={BODY_MAX_LINES} />}
      {tool.content.map((c, i) =>
        c.kind === "text" ? (
          prose ? (
            <ForgeMarkdown key={i} source={c.text} className="text-[12px]" codeBlocks />
          ) : (
            <CodeBlock key={i} code={c.text} maxLines={BODY_MAX_LINES} />
          )
        ) : c.kind === "diff" ? (
          <div key={i} className="flex flex-col gap-0.5">
            <FileLink
              target={{
                path: c.path,
                line: tool.locations.find((l) => l.path === c.path)?.line ?? null,
                newText: c.newText,
                oldText: c.oldText,
              }}
            />
            {c.oldText ? (
              <CodeBlock code={diffText(c.oldText, c.newText)} lang="diff" maxLines={BODY_MAX_LINES} />
            ) : (
              // A new file: its own language reads better than all-`+`.
              <CodeBlock code={c.newText} lang={langForPath(c.path)} maxLines={BODY_MAX_LINES} />
            )}
          </div>
        ) : (
          <div key={i} className="text-neutral-500">
            [agent terminal {c.terminalId}]
          </div>
        ),
      )}
      {tool.content.length === 0 && !command && tool.rawInput && (
        <CodeBlock code={tool.rawInput} lang="json" maxLines={BODY_MAX_LINES} />
      )}
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
  const chosen = resolved && request.options.find((o) => o.id === resolved.optionId);
  // Pending: show what's being approved. Answered: collapse to a line.
  const [open, setOpen] = useState(false);
  const showBody = (pending || open) && toolHasBody(request.tool);
  return (
    <div
      className={cn(
        "min-w-0 rounded border px-2.5 pt-2",
        // Opaque while pending: the sticky buttons below share this fill.
        pending ? "border-amber-600/60 bg-[#1a120b]" : "border-neutral-800 bg-neutral-900/40 pb-2",
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-neutral-400">
        Permission requested
        {request.tool.name && <span className="text-neutral-500">· {request.tool.name}</span>}
        {!pending && toolHasBody(request.tool) && (
          <button
            onClick={() => setOpen((o) => !o)}
            className="ml-auto flex items-center gap-0.5 text-neutral-500 hover:text-neutral-300"
          >
            <ChevronRight size={11} className={cn("transition-transform", open && "rotate-90")} />
            Details
          </button>
        )}
      </div>
      <div className="mb-2 font-mono text-[11.5px] text-neutral-200">{request.title}</div>
      {showBody && (
        <div className="mb-2 min-w-0">
          <ToolBody tool={request.tool} />
        </div>
      )}
      {pending ? (
        // Sticky to the transcript's bottom edge, so a long card can't
        // push the answer out of view while it's pending.
        <div className="sticky bottom-0 -mx-2.5 flex flex-wrap gap-1.5 rounded-b border-t border-amber-900/40 bg-[#1a120b] px-2.5 pb-2 pt-1.5">
          {request.options.map((o) => (
            <button
              key={o.id}
              onClick={() => onAnswer(request, o.id)}
              className={cn(
                "h-6 rounded px-2 text-[11px] font-medium",
                o.kind.startsWith("allow")
                  ? o.kind === "allow_once"
                    ? "bg-emerald-700 text-white hover:bg-emerald-600"
                    : "border border-emerald-700 text-emerald-300 hover:bg-emerald-950"
                  : "border border-neutral-700 text-neutral-300 hover:bg-neutral-800",
              )}
            >
              {o.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-neutral-500">
          {resolved
            ? chosen
              ? `→ ${chosen.name}`
              : "Cancelled"
            : "No longer pending"}
        </div>
      )}
    </div>
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
  return (
    <div
      className={cn(
        "min-w-0 rounded border px-2.5 py-2",
        pending ? "border-blue-600/60 bg-[#0d1420]" : "border-neutral-800 bg-neutral-900/40",
      )}
    >
      <div className="mb-1 text-[11px] text-neutral-400">Question</div>
      {question.message && (
        <ForgeMarkdown source={question.message} className="mb-2 text-[12.5px] text-neutral-100" />
      )}
      {pending ? (
        <>
          <div className="flex flex-col gap-2.5">
            {question.fields.map((f) => (
              <FormFieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
            ))}
          </div>
          <div className="mt-2.5 flex gap-1.5">
            <button
              onClick={() => onAnswer(question, "accept", questionAnswer(question.fields, values))}
              disabled={!ready}
              className="h-6 rounded bg-blue-600 px-2.5 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Submit
            </button>
            <button
              onClick={() => onAnswer(question, "decline")}
              className="h-6 rounded border border-neutral-700 px-2 text-[11px] text-neutral-300 hover:bg-neutral-800"
            >
              Skip
            </button>
          </div>
        </>
      ) : (
        <div className="text-[11px] text-neutral-500">
          {resolved?.action === "accept"
            ? `→ ${resolved.summary ?? "Answered"}`
            : resolved?.action === "decline"
              ? "Skipped"
              : resolved
                ? "Cancelled"
                : "No longer pending"}
        </div>
      )}
    </div>
  );
}

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
    <div className="mb-1">
      {field.title && (
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500">
          {field.title}
          {field.required && " *"}
        </span>
      )}
      {field.description && <div className="text-[12px] text-neutral-300">{field.description}</div>}
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
          {input.options.map((o) => (
            <button
              key={o.value}
              role={input.multi ? "checkbox" : "radio"}
              aria-checked={isOn(o.value)}
              onClick={() => {
                if (!input.multi) return onChange(isOn(o.value) ? "" : o.value);
                const cur = picked as string[];
                onChange(isOn(o.value) ? cur.filter((x) => x !== o.value) : [...cur, o.value]);
              }}
              className={cn(
                "flex items-start gap-2 rounded border px-2 py-1.5 text-left",
                isOn(o.value)
                  ? "border-blue-500/70 bg-blue-950/40"
                  : "border-neutral-800 hover:border-neutral-600 hover:bg-neutral-800/50",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center border",
                  input.multi ? "rounded-sm" : "rounded-full",
                  isOn(o.value) ? "border-blue-400 bg-blue-500" : "border-neutral-600",
                )}
              />
              <span className="min-w-0">
                <span className="block text-[12px] text-neutral-100">{o.title}</span>
                {o.description && (
                  <span className="block text-[11px] leading-snug text-neutral-500">{o.description}</span>
                )}
              </span>
            </button>
          ))}
        </div>
        {selected?.preview && <CodeBlock code={selected.preview} className="mt-1.5" maxLines={12} />}
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
    placeholder: field.title === "Other" ? "Type your own answer (optional)" : (field.title ?? ""),
    spellCheck: false,
    className:
      "w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none",
  };
  return (
    <div>
      {field.title !== "Other" && label}
      {input.kind === "text" && input.multiline ? (
        <textarea rows={1} {...common} className={cn(common.className, "resize-y")} />
      ) : (
        <input type={input.kind === "number" ? "number" : "text"} {...common} />
      )}
    </div>
  );
}

function PlanList({ entries }: { entries: AcpPlanEntry[] }) {
  return (
    <div className="max-h-36 shrink-0 overflow-y-auto border-t border-neutral-800 px-3 py-1.5">
      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500">Plan</div>
      {entries.map((e, i) => (
        <div key={i} className="flex items-baseline gap-1.5 text-[11.5px]">
          <span className="shrink-0 font-mono text-neutral-500">
            {e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"}
          </span>
          <span
            className={cn(
              e.status === "completed" && "text-neutral-500 line-through",
              e.status === "in_progress" && "text-neutral-100",
            )}
          >
            {e.content}
          </span>
        </div>
      ))}
    </div>
  );
}
