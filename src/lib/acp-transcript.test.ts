import { describe, expect, it } from "vitest";
import type { AcpEvent, AcpToolCall } from "@/ipc/types";
import {
  applyAcpEvent,
  commandOf,
  diffText,
  emptyTranscript,
  stopReasonLabel,
} from "./acp-transcript";
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
