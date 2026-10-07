import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight, Square } from "lucide-react";

import { acpCancel, acpRespondPermission, acpSetMode, agentSubmitPrompt } from "@/ipc/client";
import type {
  AcpPermissionRequest,
  AcpPlanEntry,
  AcpToolCall,
  AgentSessionId,
  WorktreeId,
} from "@/ipc/types";
import { ForgeMarkdown } from "@/components/ForgeMarkdown";
import { CodeBlock, langForPath } from "@/components/CodeBlock";
import { cn } from "@/lib/cn";
import { asMessage } from "@/lib/errors";
import { commandOf, diffText, stopReasonLabel, type AcpItem } from "@/lib/acp-transcript";
import { useToastsStore } from "@/stores/toasts";
import { createAcpLeafState, type AcpLeafState } from "./acp-leaf-state";
import type { AgentLeafMode } from "./agent-leaf-state";

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
  const t = state.transcript;
  const running = t.turns > 0 && !state.exited;

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  });

  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);
  const [draft, setDraft] = useState("");

  function reportError(title: string, e: unknown) {
    useToastsStore.getState().push({ kind: "error", title, body: asMessage(e) });
  }

  async function send() {
    const text = draft.trim();
    if (!text || !state.sessionId || state.exited) return;
    setDraft("");
    stickToBottom.current = true;
    try {
      await agentSubmitPrompt(state.sessionId, text);
    } catch (e) {
      setDraft(text);
      reportError("Couldn't send prompt", e);
    }
  }

  async function cancel() {
    if (!state.sessionId) return;
    await acpCancel(state.sessionId).catch((e) => reportError("Couldn't cancel", e));
  }

  async function setMode(modeId: string) {
    if (!state.sessionId) return;
    await acpSetMode(state.sessionId, modeId).catch((e) => reportError("Couldn't switch mode", e));
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
    <div className="flex h-full w-full flex-col text-[12.5px] text-neutral-300">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-800 px-3 text-[11px] text-neutral-500">
        <span className="rounded border border-neutral-700 px-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
          ACP
        </span>
        <span className="truncate text-neutral-300">{t.title ?? t.ready?.agentName ?? "Agent"}</span>
        <span className={cn("ml-auto shrink-0", t.pendingPermission && "text-amber-400")}>
          {status}
        </span>
        {t.modes && (
          <select
            value={t.modes.current}
            onChange={(e) => void setMode(e.target.value)}
            disabled={state.exited}
            title={
              t.modes.available.find((m) => m.id === t.modes?.current)?.description ??
              "Permission mode"
            }
            aria-label="Permission mode"
            className="h-5 shrink-0 rounded border border-neutral-700 bg-neutral-900 px-1 text-[11px] text-neutral-300 focus:border-blue-500 focus:outline-none"
          >
            {t.modes.available.map((m) => (
              <option key={m.id} value={m.id} title={m.description ?? undefined}>
                {m.name}
              </option>
            ))}
          </select>
        )}
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
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
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
        <div className="flex flex-col gap-2">
          {t.items.map((item, i) => (
            <Row
              key={i}
              item={item}
              pending={item.kind === "permission" && item.request.id === t.pendingPermission}
              onAnswer={answer}
            />
          ))}
        </div>
      </div>

      {t.plan.length > 0 && <PlanList entries={t.plan} />}

      <div className="shrink-0 border-t border-neutral-800 p-2">
        <div className="flex items-end gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 p-1.5 focus-within:border-blue-500">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape" && running) {
                e.preventDefault();
                void cancel();
              }
            }}
            rows={Math.min(8, Math.max(1, draft.split("\n").length))}
            disabled={state.exited || !!state.error}
            placeholder={
              state.exited ? "Agent exited" : running ? "Queue a follow-up…" : "Message the agent…"
            }
            spellCheck={false}
            className="min-w-0 flex-1 resize-none bg-transparent px-1 py-0.5 text-[12.5px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none disabled:opacity-50"
          />
          {running && (
            <button
              onClick={() => void cancel()}
              title="Cancel the running turn (Esc)"
              className="flex h-6 shrink-0 items-center gap-1 rounded border border-neutral-700 px-2 text-[11px] text-neutral-300 hover:bg-neutral-800"
            >
              <Square size={9} fill="currentColor" />
              Cancel
            </button>
          )}
          <button
            onClick={() => void send()}
            disabled={!draft.trim() || !state.sessionId || state.exited}
            className="h-6 shrink-0 rounded bg-blue-600 px-2 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </div>
        <div className="px-1 pt-1 text-[10px] text-neutral-600">⏎ send · ⇧⏎ newline · Esc cancel</div>
      </div>
    </div>
  );
}

const Row = memo(function Row({
  item,
  pending,
  onAnswer,
}: {
  item: AcpItem;
  pending: boolean;
  onAnswer: (req: AcpPermissionRequest, optionId: string) => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="self-end whitespace-pre-wrap rounded-md bg-neutral-800 px-2.5 py-1.5 text-neutral-100 max-w-[90%]">
          {item.text}
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

function toolHasBody(tool: AcpToolCall): boolean {
  return tool.content.length > 0 || tool.locations.length > 0 || !!tool.rawInput;
}

/// What a tool call does / did: its command, diffs (highlighted as diffs),
/// output, or — when the agent sent no content — its raw input.
function ToolBody({ tool }: { tool: AcpToolCall }) {
  const command = commandOf(tool);
  // Plans (leaving plan mode) and reasoning come as prose, not code.
  const prose = tool.kind === "switch_mode" || tool.kind === "think";
  return (
    <div className="flex flex-col gap-1.5 text-[11px]">
      {tool.locations
        .filter((l) => !tool.content.some((c) => c.kind === "diff" && c.path === l))
        .map((l) => (
          <div key={l} className="truncate font-mono text-neutral-500">
            {l}
          </div>
        ))}
      {command && <CodeBlock code={command} lang="bash" />}
      {tool.content.map((c, i) =>
        c.kind === "text" ? (
          prose ? (
            <ForgeMarkdown key={i} source={c.text} className="text-[12px]" codeBlocks />
          ) : (
            <CodeBlock key={i} code={c.text} />
          )
        ) : c.kind === "diff" ? (
          <div key={i} className="flex flex-col gap-0.5">
            <div className="truncate font-mono text-neutral-500">{c.path}</div>
            {c.oldText ? (
              <CodeBlock code={diffText(c.oldText, c.newText)} lang="diff" />
            ) : (
              // A new file: its own language reads better than all-`+`.
              <CodeBlock code={c.newText} lang={langForPath(c.path)} />
            )}
          </div>
        ) : (
          <div key={i} className="text-neutral-500">
            [agent terminal {c.terminalId}]
          </div>
        ),
      )}
      {tool.content.length === 0 && !command && tool.rawInput && (
        <CodeBlock code={tool.rawInput} lang="json" />
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
        "rounded border px-2.5 py-2",
        pending ? "border-amber-600/60 bg-amber-950/20" : "border-neutral-800 bg-neutral-900/40",
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
        <div className="mb-2 max-h-96 overflow-y-auto">
          <ToolBody tool={request.tool} />
        </div>
      )}
      {pending ? (
        <div className="flex flex-wrap gap-1.5">
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
