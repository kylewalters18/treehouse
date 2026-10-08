import { describe, expect, it } from "vitest";
import type { AcpEvent, AcpToolCall } from "@/ipc/types";
import {
  applyAcpEvent,
  canSubmitAnswer,
  commandOf,
  diffText,
  emptyTranscript,
  lineDiffStats,
  lineOfSnippet,
  questionAnswer,
  stopReasonLabel,
  turnChanges,
  type AcpItem,
} from "./acp-transcript";
import type { AcpFormField } from "@/ipc/types";
import { langForPath } from "@/components/CodeBlock";

function tool(status: string, title = "`cargo test`"): AcpToolCall {
  return {
    id: "t1",
    title,
    kind: "execute",
    status,
    name: "Bash",
    locations: [],
    content: [],
    rawInput: null,
  };
}

const FIELDS: AcpFormField[] = [
  {
    key: "question_0",
    title: "Cache",
    description: null,
    required: false,
    input: { kind: "choice", multi: false, options: [{ value: "Redis", title: "Redis", description: null, preview: null }] },
  },
  { key: "question_0_custom", title: "Other", description: null, required: false, input: { kind: "text", multiline: true } },
  {
    key: "targets",
    title: null,
    description: null,
    required: false,
    input: { kind: "choice", multi: true, options: [] },
  },
  { key: "count", title: null, description: null, required: false, input: { kind: "number", integer: true } },
];

function fold(events: AcpEvent[]) {
  const t = emptyTranscript();
  for (const ev of events) applyAcpEvent(t, ev);
  return t;
}

describe("applyAcpEvent", () => {
  it("merges text chunks and upserts tool calls in place", () => {
    const t = fold([
      { kind: "ready", sessionId: "s1", agentName: "Claude Agent", mcpAttached: true, cli: "/u/bin/claude", acceptsImages: true },
      { kind: "userMessage", text: "run tests", attachments: ["@src/lib.rs"] },
      { kind: "agentText", text: "On " },
      { kind: "agentText", text: "it." },
      { kind: "tool", tool: tool("pending") },
      { kind: "agentText", text: "Done." },
      { kind: "tool", tool: tool("completed") },
      { kind: "turnEnded", stopReason: "end_turn" },
    ]);
    expect(t.ready?.sessionId).toBe("s1");
    expect(t.ready?.cli).toBe("/u/bin/claude");
    expect(t.items.map((i) => i.kind)).toEqual(["user", "agent", "tool", "agent", "turnEnd"]);
    expect(t.items[0]).toEqual({ kind: "user", text: "run tests", attachments: ["@src/lib.rs"] });
    expect(t.items[1]).toEqual({ kind: "agent", text: "On it." });
    expect(t.items[2]).toEqual({ kind: "tool", tool: tool("completed") });
    expect(t.turns).toBe(0);
  });

  it("tracks a permission prompt until it is resolved", () => {
    const request = {
      id: "7",
      toolCallId: "t1",
      tool: tool("pending", "`rm -rf build`"),
      title: "`rm -rf build`",
      options: [
        { id: "allow", name: "Allow", kind: "allow_once" },
        { id: "reject", name: "Reject", kind: "reject_once" },
      ],
    };
    const t = fold([
      { kind: "userMessage", text: "clean", attachments: [] },
      { kind: "permission", request },
    ]);
    expect(t.pendingPermission).toBe("7");
    applyAcpEvent(t, { kind: "permissionResolved", requestId: "7", optionId: "reject" });
    expect(t.pendingPermission).toBeNull();
    expect(t.items[1]).toEqual({ kind: "permission", request, resolved: { optionId: "reject" } });
  });

  it("replaces changed rows rather than mutating them", () => {
    const t = fold([{ kind: "agentText", text: "a" }]);
    const before = t.items[0];
    applyAcpEvent(t, { kind: "agentText", text: "b" });
    expect(t.items[0]).not.toBe(before);
    expect(before).toEqual({ kind: "agent", text: "a" });
  });

  it("keeps the latest plan and title", () => {
    const t = fold([
      { kind: "plan", entries: [{ content: "a", status: "pending", priority: "high" }] },
      { kind: "plan", entries: [{ content: "b", status: "completed", priority: "low" }] },
      { kind: "title", title: "Fix CI" },
    ]);
    expect(t.plan.map((e) => e.content)).toEqual(["b"]);
    expect(t.title).toBe("Fix CI");
  });

  it("tracks the current mode", () => {
    const available = [
      { id: "default", name: "Manual", description: null },
      { id: "plan", name: "Plan", description: null },
    ];
    const t = fold([
      { kind: "modes", modes: { current: "default", available } },
      { kind: "modes", modes: { current: "plan", available } },
    ]);
    expect(t.modes?.current).toBe("plan");
  });

  it("replays loaded history without starting turns", () => {
    const t = fold([
      { kind: "userText", text: "What does " },
      { kind: "userText", text: "lib.rs do?" },
      { kind: "agentText", text: "It wires the builder." },
      { kind: "userText", text: "Thanks" },
    ]);
    expect(t.items).toEqual([
      { kind: "user", text: "What does lib.rs do?", attachments: [] },
      { kind: "agent", text: "It wires the builder." },
      { kind: "user", text: "Thanks", attachments: [] },
    ]);
    expect(t.turns).toBe(0);
  });

  it("keeps the latest commands and usage", () => {
    const t = fold([
      { kind: "commands", commands: [{ name: "compact", description: "Compact", hint: null }] },
      { kind: "usage", usage: { used: 1, size: 10, cost: null, currency: null } },
      { kind: "usage", usage: { used: 5, size: 10, cost: 0.1, currency: "USD" } },
    ]);
    expect(t.commands.map((c) => c.name)).toEqual(["compact"]);
    expect(t.usage?.used).toBe(5);
  });

  it("counts queued turns", () => {
    const t = fold([
      { kind: "userMessage", text: "one", attachments: [] },
      { kind: "userMessage", text: "two", attachments: [] },
      { kind: "turnEnded", stopReason: "end_turn" },
    ]);
    expect(t.turns).toBe(1);
    applyAcpEvent(t, { kind: "turnEnded", stopReason: "cancelled" });
    applyAcpEvent(t, { kind: "turnEnded", stopReason: "end_turn" });
    expect(t.turns).toBe(0);
  });
});

describe("stopReasonLabel", () => {
  it("hides ordinary finishes", () => {
    expect(stopReasonLabel("end_turn")).toBeNull();
    expect(stopReasonLabel("cancelled")).toBe("Cancelled");
    expect(stopReasonLabel("weird")).toBe("Stopped: weird");
  });
});

describe("tool body helpers", () => {
  it("pulls the command out of an execute call's raw input", () => {
    const bash = { ...tool("pending"), rawInput: JSON.stringify({ command: "cargo test", timeout: 5 }) };
    expect(commandOf(bash)).toBe("cargo test");
    expect(commandOf({ ...bash, kind: "read" })).toBeNull();
    expect(commandOf({ ...bash, rawInput: "{not json" })).toBeNull();
  });

  it("formats edits as -/+ lines", () => {
    expect(diffText("a\nb\n", "c\n")).toBe("-a\n-b\n+c");
  });

  it("maps file extensions to fence languages", () => {
    expect(langForPath("/r/src/main.rs")).toBe("rust");
    expect(langForPath("App.TSX")).toBe("tsx");
    expect(langForPath("Makefile")).toBe("text");
  });
});

describe("questions", () => {
  it("tracks a question until it is answered", () => {
    const question = { id: "4", message: "Which cache?", toolCallId: null, fields: FIELDS };
    const t = fold([
      { kind: "userMessage", text: "set up", attachments: [] },
      { kind: "question", question },
    ]);
    expect(t.pendingQuestion).toBe("4");
    applyAcpEvent(t, { kind: "questionResolved", requestId: "4", action: "accept", summary: "Redis" });
    expect(t.pendingQuestion).toBeNull();
    expect(t.items[1]).toEqual({
      kind: "question",
      question,
      resolved: { action: "accept", summary: "Redis" },
    });
  });

  it("builds answers from filled fields only", () => {
    expect(
      questionAnswer(FIELDS, {
        question_0: "Redis",
        question_0_custom: "  ",
        targets: [],
        count: "3",
      }),
    ).toEqual({ question_0: "Redis", count: 3 });
    expect(canSubmitAnswer(FIELDS, {})).toBe(false);
    expect(canSubmitAnswer(FIELDS, { question_0_custom: "Memcached" })).toBe(true);
    const required = [{ ...FIELDS[0], required: true }, FIELDS[1]];
    expect(canSubmitAnswer(required, { question_0_custom: "x" })).toBe(false);
  });
});

describe("lineOfSnippet", () => {
  const file = "fn a() {}\n\nfn b() {\n    let x = 1;\n}\n";
  it("finds where an edit's text starts", () => {
    expect(lineOfSnippet(file, "fn b() {\n    let x = 1;")).toBe(3);
    // Indentation differences fall back to the first line.
    expect(lineOfSnippet(file, "  let x = 1;\n  other")).toBe(4);
    expect(lineOfSnippet(file, "nowhere")).toBeNull();
    expect(lineOfSnippet(file, "\n\n")).toBeNull();
  });
});

describe("lineDiffStats", () => {
  it("counts only the lines that changed", () => {
    const old = "a\nb\nc\nd\ne\n";
    expect(lineDiffStats(old, "a\nb\nX\nd\ne\n")).toEqual({ added: 1, removed: 1 });
    expect(lineDiffStats(old, "a\nb\nc\nnew\nd\ne")).toEqual({ added: 1, removed: 0 });
    expect(lineDiffStats("", "x\ny")).toEqual({ added: 2, removed: 0 });
    expect(lineDiffStats("x\ny", "")).toEqual({ added: 0, removed: 2 });
    expect(lineDiffStats("p\nq\nr", "q\nr\np")).toEqual({ added: 1, removed: 1 });
  });
});

describe("turnChanges", () => {
  const tool = (id: string, over: Partial<AcpToolCall>): AcpItem => ({
    kind: "tool",
    tool: {
      id,
      title: id,
      kind: "edit",
      status: "completed",
      name: null,
      locations: [],
      content: [],
      rawInput: null,
      ...over,
    },
  });
  const diff = (path: string, oldText: string | null, newText: string) => ({
    kind: "diff" as const,
    path,
    oldText,
    newText,
  });

  it("sums a turn's edits per file and ignores earlier turns and failures", () => {
    const items: AcpItem[] = [
      tool("t0", { content: [diff("/r/old.rs", "a", "b")] }),
      { kind: "turnEnd", stopReason: "end_turn" },
      { kind: "user", text: "go", attachments: [] },
      tool("t1", { content: [diff("/r/lib.rs", "a\nb\nc", "a\nB\nc")] }),
      tool("t2", { content: [diff("/r/new.rs", null, "x\ny\nz")] }),
      tool("t3", { content: [diff("/r/lib.rs", "c", "c\nd")] }),
      tool("t4", { status: "failed", content: [diff("/r/nope.rs", "a", "b")] }),
      tool("t5", { kind: "delete", locations: [{ path: "/r/gone.rs", line: null }] }),
      { kind: "agent", text: "done" },
      { kind: "turnEnd", stopReason: "end_turn" },
    ];
    expect(turnChanges(items, 9)).toEqual([
      { path: "/r/lib.rs", status: "modified", added: 2, removed: 1 },
      { path: "/r/new.rs", status: "added", added: 3, removed: 0 },
      { path: "/r/gone.rs", status: "deleted", added: 0, removed: 0 },
    ]);
    expect(turnChanges(items, 1)).toEqual([
      { path: "/r/old.rs", status: "modified", added: 1, removed: 1 },
    ]);
  });
});
