import type {
  AcpCommand,
  AcpConfigOption,
  AcpEvent,
  AcpModes,
  AcpUsage,
  AcpPermissionRequest,
  AcpFormField,
  AcpPlanEntry,
  AcpQuestion,
  AcpToolCall,
} from "@/ipc/types";

/// One row of an ACP agent's transcript, as the pane renders it.
export type AcpItem =
  /// `attachments` labels files/images sent with it; empty for replayed
  /// history.
  | { kind: "user"; text: string; attachments: string[] }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; tool: AcpToolCall }
  | {
      kind: "permission";
      request: AcpPermissionRequest;
      /// `undefined` while pending; `optionId` null = cancelled.
      resolved?: { optionId: string | null };
    }
  | {
      kind: "question";
      question: AcpQuestion;
      /// `undefined` while pending.
      resolved?: { action: string; summary: string | null };
    }
  | { kind: "turnEnd"; stopReason: string }
  | { kind: "error"; message: string };

export type AcpTranscript = {
  items: AcpItem[];
  /// Latest plan; ACP replaces it wholesale on every update.
  plan: AcpPlanEntry[];
  title: string | null;
  ready: {
    sessionId: string;
    agentName: string | null;
    mcpAttached: boolean;
    /// Claude CLI the adapter drives; null = its bundled copy.
    cli: string | null;
    acceptsImages: boolean;
  } | null;
  /// Prompts sent whose turn hasn't ended (the adapter may queue several).
  turns: number;
  /// Request id of the permission prompt awaiting an answer, if any.
  pendingPermission: string | null;
  /// Request id of the question awaiting an answer, if any.
  pendingQuestion: string | null;
  /// Permission modes the agent offers, and the current one.
  modes: AcpModes | null;
  /// Slash commands for prompt autocomplete.
  commands: AcpCommand[];
  usage: AcpUsage | null;
  /// Session settings: model, effort, mode, fast, …
  config: AcpConfigOption[];
};

export function emptyTranscript(): AcpTranscript {
  return {
    items: [],
    plan: [],
    title: null,
    ready: null,
    turns: 0,
    pendingPermission: null,
    pendingQuestion: null,
    modes: null,
    commands: [],
    usage: null,
    config: [],
  };
}

/// Fold one event into `t`, in place. Items that change are replaced with
/// new objects (never mutated) so row components can memoize on identity.
/// A replayed log (`acpBatch`) and the live stream go through the same path.
export function applyAcpEvent(t: AcpTranscript, ev: AcpEvent): void {
  const last = t.items[t.items.length - 1];
  switch (ev.kind) {
    case "ready":
      t.ready = {
        sessionId: ev.sessionId,
        agentName: ev.agentName,
        mcpAttached: ev.mcpAttached,
        cli: ev.cli,
        acceptsImages: ev.acceptsImages,
      };
      break;
    case "userMessage":
      t.turns += 1;
      t.items.push({ kind: "user", text: ev.text, attachments: ev.attachments });
      break;
    case "userText":
      // Replayed history (`session/load`): no turn of its own.
      if (last?.kind === "user") {
        t.items[t.items.length - 1] = { ...last, text: last.text + ev.text };
      } else {
        t.items.push({ kind: "user", text: ev.text, attachments: [] });
      }
      break;
    case "commands":
      t.commands = ev.commands;
      break;
    case "usage":
      t.usage = ev.usage;
      break;
    case "config":
      t.config = ev.options;
      break;
    case "agentText":
      if (last?.kind === "agent") {
        t.items[t.items.length - 1] = { kind: "agent", text: last.text + ev.text };
      } else {
        t.items.push({ kind: "agent", text: ev.text });
      }
      break;
    case "thought":
      if (last?.kind === "thought") {
        t.items[t.items.length - 1] = { kind: "thought", text: last.text + ev.text };
      } else {
        t.items.push({ kind: "thought", text: ev.text });
      }
      break;
    case "tool": {
      const i = t.items.findIndex((it) => it.kind === "tool" && it.tool.id === ev.tool.id);
      if (i >= 0) t.items[i] = { kind: "tool", tool: ev.tool };
      else t.items.push({ kind: "tool", tool: ev.tool });
      break;
    }
    case "plan":
      t.plan = ev.entries;
      break;
    case "permission":
      t.pendingPermission = ev.request.id;
      t.items.push({ kind: "permission", request: ev.request });
      break;
    case "permissionResolved": {
      const i = t.items.findIndex(
        (it) => it.kind === "permission" && it.request.id === ev.requestId && !it.resolved,
      );
      if (i >= 0) {
        const it = t.items[i] as Extract<AcpItem, { kind: "permission" }>;
        t.items[i] = { ...it, resolved: { optionId: ev.optionId } };
      }
      if (t.pendingPermission === ev.requestId) t.pendingPermission = null;
      break;
    }
    case "question":
      t.pendingQuestion = ev.question.id;
      t.items.push({ kind: "question", question: ev.question });
      break;
    case "questionResolved": {
      const i = t.items.findIndex(
        (it) => it.kind === "question" && it.question.id === ev.requestId && !it.resolved,
      );
      if (i >= 0) {
        const it = t.items[i] as Extract<AcpItem, { kind: "question" }>;
        t.items[i] = { ...it, resolved: { action: ev.action, summary: ev.summary } };
      }
      if (t.pendingQuestion === ev.requestId) t.pendingQuestion = null;
      break;
    }
    case "turnEnded":
      t.turns = Math.max(0, t.turns - 1);
      if (t.turns === 0) {
        t.pendingPermission = null;
        t.pendingQuestion = null;
      }
      t.items.push({ kind: "turnEnd", stopReason: ev.stopReason });
      break;
    case "title":
      t.title = ev.title;
      break;
    case "modes":
      t.modes = ev.modes;
      break;
    case "error":
      t.items.push({ kind: "error", message: ev.message });
      break;
  }
}

/// Label for how a turn ended, or null for an ordinary finish.
export function stopReasonLabel(reason: string): string | null {
  switch (reason) {
    case "end_turn":
      return null;
    case "cancelled":
      return "Cancelled";
    case "max_tokens":
      return "Stopped: hit the token limit";
    case "max_turn_requests":
      return "Stopped: hit the turn limit";
    case "refusal":
      return "The agent refused to continue";
    case "error":
      return "Turn failed";
    default:
      return `Stopped: ${reason}`;
  }
}

/// The command an execute-kind tool call runs, from its raw input.
export function commandOf(tool: AcpToolCall): string | null {
  if (tool.kind !== "execute" || !tool.rawInput) return null;
  try {
    const v = JSON.parse(tool.rawInput) as { command?: unknown };
    return typeof v.command === "string" ? v.command : null;
  } catch {
    return null;
  }
}

/// An edit's replaced and replacement text as `-`/`+` lines, for diff
/// highlighting. Copy yields this text.
export function diffText(oldText: string, newText: string): string {
  const lines = (text: string, p: string) =>
    text
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => p + l);
  return [...lines(oldText, "-"), ...lines(newText, "+")].join("\n");
}

/// A form value as the pane holds it.
export type FormValue = string | string[] | boolean;

/// The `content` to accept a question with: filled fields only (blank
/// text and empty selections are left out), numbers parsed.
export function questionAnswer(
  fields: AcpFormField[],
  values: Record<string, FormValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined) continue;
    if (f.input.kind === "number") {
      const n = Number(v);
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(n)) out[f.key] = n;
    } else if (typeof v === "string") {
      if (v.trim()) out[f.key] = v.trim();
    } else if (Array.isArray(v)) {
      if (v.length > 0) out[f.key] = v;
    } else {
      out[f.key] = v;
    }
  }
  return out;
}

/// A question can be submitted once its required fields are filled and
/// something is answered at all.
export function canSubmitAnswer(
  fields: AcpFormField[],
  values: Record<string, FormValue>,
): boolean {
  const answer = questionAnswer(fields, values);
  return (
    Object.keys(answer).length > 0 && fields.every((f) => !f.required || f.key in answer)
  );
}

/// 1-based line where `snippet` starts in `text`: the whole snippet if it
/// occurs, else its first non-blank line (trimmed). Null if not found.
export function lineOfSnippet(text: string, snippet: string): number | null {
  const lineAt = (i: number) => text.slice(0, i).split("\n").length;
  const trimmed = snippet.replace(/^\n+/, "").replace(/\s+$/, "");
  if (trimmed) {
    const i = text.indexOf(trimmed);
    if (i >= 0) return lineAt(i);
  }
  const first = snippet.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.includes(first));
  return idx >= 0 ? idx + 1 : null;
}
