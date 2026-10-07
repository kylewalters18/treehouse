import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/ipc/client", () => ({
  acpAnswerQuestion: vi.fn(async () => {}),
  acpCancel: vi.fn(async () => {}),
  acpRespondPermission: vi.fn(async () => {}),
  acpSendPrompt: vi.fn(async () => {}),
  acpSetConfig: vi.fn(async () => {}),
  acpSetMode: vi.fn(async () => {}),
  readFile: vi.fn(async () => ({ text: "fn a() {}\nfn calculate() {}\n", size: 0n, binary: false })),
  listFiles: vi.fn(async () => []),
  attachAgent: vi.fn(),
  launchAgent: vi.fn(),
  killAgent: vi.fn(async () => {}),
}));
vi.mock("./term-path-links", () => ({ openWorktreeFile: vi.fn(async () => true) }));
// Shiki's WASM load isn't needed to test behavior; blocks render plain.
vi.mock("@/panels/markdown-shiki", () => ({
  getMarkdownHighlighter: () => new Promise(() => {}),
  highlightCode: () => "",
}));

import * as client from "@/ipc/client";
import { openWorktreeFile } from "./term-path-links";
import { AcpAgentSlot } from "./AcpAgentSlot";
import type { AcpLeafState } from "./acp-leaf-state";
import { applyAcpEvent, emptyTranscript } from "@/lib/acp-transcript";
import type { AcpEvent, AcpToolCall } from "@/ipc/types";
import { useWorktreesStore } from "@/stores/worktrees";

function renderSlot(events: AcpEvent[]) {
  const transcript = emptyTranscript();
  for (const e of events) applyAcpEvent(transcript, e);
  const state: AcpLeafState = {
    sessionId: "agent-1",
    transcript,
    version: 1,
    listeners: new Set(),
    exited: false,
    error: null,
    killed: false,
  };
  render(
    <AcpAgentSlot
      worktreeId="wt-1"
      mode={{ kind: "attach", agentId: "agent-1" }}
      poolKey="agent-1"
      visible
      leafStates={new Map([["agent-1", state]])}
      onSession={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorktreesStore.setState({
    worktrees: [{ id: "wt-1", path: "/repo" } as never],
  });
});

describe("questions", () => {
  const question: AcpEvent = {
    kind: "question",
    question: {
      id: "9",
      message: "Which cache should I use?",
      toolCallId: null,
      fields: [
        {
          key: "question_0",
          title: "Cache",
          description: null,
          required: false,
          input: {
            kind: "choice",
            multi: false,
            options: [
              { value: "Redis", title: "Redis", description: "In-memory", preview: null },
              { value: "None", title: "None", description: null, preview: null },
            ],
          },
        },
        {
          key: "question_0_custom",
          title: "Other",
          description: null,
          required: false,
          input: { kind: "text", multiline: true },
        },
      ],
    },
  };

  it("submits the picked option", async () => {
    renderSlot([{ kind: "userMessage", text: "add caching", attachments: [] }, question]);
    expect(screen.getByText("Which cache should I use?")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: /Redis/ }));
    await userEvent.click(submit);
    expect(client.acpAnswerQuestion).toHaveBeenCalledWith("agent-1", "9", "accept", {
      question_0: "Redis",
    });
  });

  it("skips, and shows answered questions as a summary", async () => {
    renderSlot([
      { kind: "userMessage", text: "add caching", attachments: [] },
      question,
      { kind: "questionResolved", requestId: "9", action: "accept", summary: "Redis" },
    ]);
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(screen.getByText("→ Redis")).toBeTruthy();
  });

  it("declines with Skip", async () => {
    renderSlot([{ kind: "userMessage", text: "x", attachments: [] }, question]);
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(client.acpAnswerQuestion).toHaveBeenCalledWith("agent-1", "9", "decline", undefined);
  });
});

describe("opening files from tool calls", () => {
  const edit: AcpToolCall = {
    id: "t1",
    title: "Edit src/lib.rs",
    kind: "edit",
    status: "completed",
    name: "Edit",
    locations: [{ path: "/repo/src/lib.rs", line: null }],
    content: [{ kind: "diff", path: "/repo/src/lib.rs", oldText: "fn compute() {}", newText: "fn calculate() {}" }],
    rawInput: null,
  };

  it("opens an edit at the changed line, found by searching the file", async () => {
    renderSlot([{ kind: "tool", tool: edit }]);
    await userEvent.click(screen.getByTitle("Open src/lib.rs in the editor"));
    await waitFor(() => expect(openWorktreeFile).toHaveBeenCalledWith("wt-1", "src/lib.rs", 2));
    expect(client.readFile).toHaveBeenCalledWith("wt-1", "src/lib.rs");
  });

  it("uses the agent's line when it gives one, and lists locations as links", async () => {
    const read: AcpToolCall = {
      ...edit,
      id: "t2",
      kind: "read",
      title: "Read lib.rs",
      content: [],
      locations: [
        { path: "/repo/src/lib.rs", line: 40 },
        { path: "/elsewhere/x.rs", line: null },
      ],
    };
    renderSlot([{ kind: "tool", tool: read }]);
    // Expand the card to see its locations.
    await userEvent.click(screen.getByText("Read lib.rs"));
    await userEvent.click(screen.getByRole("button", { name: "src/lib.rs:40" }));
    expect(openWorktreeFile).toHaveBeenCalledWith("wt-1", "src/lib.rs", 40);
    expect(client.readFile).not.toHaveBeenCalled();
    // Outside the worktree: shown, not clickable.
    expect(screen.queryByRole("button", { name: "/elsewhere/x.rs" })).toBeNull();
    expect(screen.getByTitle("/elsewhere/x.rs (outside this worktree)")).toBeTruthy();
  });
});

describe("editing the last prompt", () => {
  it("offers Edit only on the last prompt and loads it into the composer", async () => {
    renderSlot([
      { kind: "ready", sessionId: "s", agentName: "Claude", mcpAttached: true, cli: null, acceptsImages: true },
      { kind: "userMessage", text: "first", attachments: [] },
      { kind: "turnEnded", stopReason: "end_turn" } as AcpEvent,
      { kind: "userMessage", text: "second", attachments: [] },
    ]);
    const edits = screen.getAllByRole("button", { name: "Edit and resend" });
    expect(edits).toHaveLength(1);
    await userEvent.click(edits[0]);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("second");
    expect(screen.getByText(/Editing a sent message/)).toBeTruthy();
  });
});

describe("⌃C", () => {
  it("interrupts a running turn from anywhere in the pane", async () => {
    renderSlot([
      { kind: "ready", sessionId: "s", agentName: "Claude", mcpAttached: true, cli: null, acceptsImages: true },
      { kind: "userMessage", text: "go", attachments: [] },
    ]);
    await userEvent.click(screen.getByRole("textbox"));
    await userEvent.keyboard("{Control>}c{/Control}");
    expect(client.acpCancel).toHaveBeenCalledWith("agent-1");
  });
});
