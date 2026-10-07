import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight } from "lucide-react";

import {
  acpCancel,
  acpRespondPermission,
  acpSendPrompt,
  acpSetConfig,
  acpSetMode,
} from "@/ipc/client";
import type {
  AcpAttachment,
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
import { AcpPromptBox } from "./AcpPromptBox";
import { composerControls, type ComposerPicker } from "@/lib/acp-composer";
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
              pending={item.kind === "permission" && item.request.id === t.pendingPermission}
              onAnswer={answer}
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
/// Long code collapses past this many lines (see `CodeBlock`).
const BODY_MAX_LINES = 16;

function ToolBody({ tool }: { tool: AcpToolCall }) {
  const command = commandOf(tool);
  // Plans (leaving plan mode) and reasoning come as prose, not code.
  const prose = tool.kind === "switch_mode" || tool.kind === "think";
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-[11px]">
      {tool.locations
        .filter((l) => !tool.content.some((c) => c.kind === "diff" && c.path === l))
        .map((l) => (
          <div key={l} className="truncate font-mono text-neutral-500">
            {l}
          </div>
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
            <div className="truncate font-mono text-neutral-500">{c.path}</div>
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
