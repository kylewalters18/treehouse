import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/ipc/client", () => ({
  acpAnswerQuestion: vi.fn(async () => {}),
  acpCancel: vi.fn(async () => []),
  acpRemoveFollowup: vi.fn(async () => null),
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
import { emptyComposerStash } from "./AcpPromptBox";
import { applyAcpEvent, emptyTranscript } from "@/lib/acp-transcript";
import type { AcpEvent, AcpToolCall } from "@/ipc/types";
import { useWorktreesStore } from "@/stores/worktrees";
import { useDiffsStore } from "@/stores/diffs";

function renderSlot(events: AcpEvent[], extra: Partial<AcpLeafState> = {}) {
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
    composer: emptyComposerStash(),
    turnStartedAt: null,
    lastEventAt: Date.now(),
    ...extra,
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

describe("files changed this turn", () => {
  it("summarizes the turn's files and opens one in the diff", async () => {
    renderSlot([
      { kind: "userMessage", text: "refactor", attachments: [] },
      {
        kind: "turnChanges",
        files: [
          { path: "src/lib.rs", status: "modified", added: 1, removed: 1, binary: false },
          { path: "src/new.rs", status: "added", added: 2, removed: 0, binary: false },
          { path: "logo.png", status: "added", added: 0, removed: 0, binary: true },
        ],
      },
      { kind: "turnEnded", stopReason: "end_turn" },
    ]);
    expect(screen.getByText("3 files changed")).toBeTruthy();
    expect(screen.getByText("binary")).toBeTruthy();
    await userEvent.click(screen.getByTitle("Open src/new.rs in the diff"));
    const d = useDiffsStore.getState();
    expect(d.selectedFile["wt-1"]).toBe("src/new.rs");
    expect(d.selectedGroup["wt-1"]).toBe("branch");
    expect(d.view["wt-1"]).toBe("diff");
  });

  it("shows nothing for a turn without changes", () => {
    renderSlot([
      { kind: "userMessage", text: "hi", attachments: [] },
      { kind: "agentText", text: "hello" },
      { kind: "turnEnded", stopReason: "end_turn" },
    ]);
    expect(screen.queryByText(/files? changed/)).toBeNull();
  });
});

const READY: AcpEvent = {
  kind: "ready",
  sessionId: "s",
  agentName: "Claude",
  mcpAttached: true,
  cli: null,
  acceptsImages: true,
};

function toolCall(id: string, kind: string, status: string, title: string, path?: string): AcpToolCall {
  return {
    id,
    title,
    kind,
    status,
    name: null,
    locations: path ? [{ path, line: null }] : [],
    content: [],
    rawInput: null,
  };
}

describe("permission shortcuts", () => {
  const permission: AcpEvent = {
    kind: "permission",
    request: {
      id: "p1",
      toolCallId: "t1",
      title: "rm -rf build",
      options: [
        { id: "once", name: "Allow", kind: "allow_once" },
        { id: "always", name: "Always allow", kind: "allow_always" },
        { id: "no", name: "Reject", kind: "reject_once" },
      ],
      tool: toolCall("t1", "execute", "pending", "rm -rf build"),
    },
  };

  it("answers with a digit typed into the empty composer", async () => {
    renderSlot([READY, { kind: "userMessage", text: "clean", attachments: [] }, permission]);
    await userEvent.click(screen.getByRole("textbox"));
    await userEvent.keyboard("3");
    expect(client.acpRespondPermission).toHaveBeenCalledWith("agent-1", "p1", "no");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("leaves digits alone while there's a draft", async () => {
    renderSlot([READY, { kind: "userMessage", text: "clean", attachments: [] }, permission]);
    await userEvent.click(screen.getByRole("textbox"));
    await userEvent.keyboard("x1");
    expect(client.acpRespondPermission).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("x1");
  });
});

describe("working status", () => {
  it("shows elapsed time and the running tool in the header", () => {
    renderSlot(
      [
        READY,
        { kind: "userMessage", text: "test it", attachments: [] },
        { kind: "tool", tool: toolCall("t1", "execute", "in_progress", "`npm test`") },
      ],
      { turnStartedAt: Date.now() - 65_000 },
    );
    expect(screen.getByTitle("Working · 1m 05s · npm test")).toBeTruthy();
  });

  it("says it's thinking when nothing has arrived for a while", () => {
    renderSlot([READY, { kind: "userMessage", text: "go", attachments: [] }], {
      lastEventAt: Date.now() - 5_000,
    });
    expect(screen.getByRole("status").textContent).toContain("Thinking…");
  });

  it("stays quiet while a tool runs", () => {
    renderSlot(
      [
        READY,
        { kind: "userMessage", text: "go", attachments: [] },
        { kind: "tool", tool: toolCall("t1", "read", "in_progress", "Read a.rs") },
      ],
      { lastEventAt: Date.now() - 5_000 },
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("folding tool runs", () => {
  const run: AcpEvent[] = [
    { kind: "tool", tool: toolCall("t1", "read", "completed", "Read a.rs", "/repo/a.rs") },
    { kind: "thought", text: "hmm" },
    { kind: "tool", tool: toolCall("t2", "read", "completed", "Read b.rs", "/repo/b.rs") },
    { kind: "tool", tool: toolCall("t3", "execute", "failed", "cargo test") },
  ];

  it("folds a finished turn's run to a summary that expands", async () => {
    renderSlot([
      READY,
      { kind: "userMessage", text: "look", attachments: [] },
      ...run,
      { kind: "agentText", text: "done" },
      { kind: "turnEnded", stopReason: "end_turn" },
    ]);
    expect(screen.queryByText("Read a.rs")).toBeNull();
    await userEvent.click(screen.getByText("Read 2 files, ran 1 command"));
    expect(screen.getByText("Read a.rs")).toBeTruthy();
    expect(screen.getByText("1 failed")).toBeTruthy();
  });

  it("keeps the running turn's run expanded", () => {
    renderSlot([READY, { kind: "userMessage", text: "look", attachments: [] }, ...run]);
    expect(screen.getByText("Read a.rs")).toBeTruthy();
    expect(screen.queryByText("Read 2 files, ran 1 command")).toBeNull();
  });
});

describe("pinned prompt header", () => {
  const events: AcpEvent[] = [
    READY,
    { kind: "userMessage", text: "first ask", attachments: [] },
    { kind: "agentText", text: "one" },
    { kind: "turnEnded", stopReason: "end_turn" },
    { kind: "userMessage", text: "\n  second ask\nmore", attachments: [] },
    { kind: "agentText", text: "two" },
    { kind: "turnEnded", stopReason: "end_turn" },
    { kind: "userMessage", text: "", attachments: ["src/shot.png"] },
    { kind: "agentText", text: "three" },
    { kind: "turnEnded", stopReason: "end_turn" },
  ];

  /// Lay prompts out at fixed spots in a transcript whose top is at 100:
  /// the first two scrolled past the top, the third below it.
  function layout() {
    const tops: Record<string, number> = { "0": -400, "3": 20, "6": 600 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const p = this.dataset.prompt;
      const top = p !== undefined ? tops[p] : 100;
      return { top, bottom: top + 30, left: 0, right: 0, width: 0, height: 30, x: 0, y: top } as DOMRect;
    });
    const scroller = document.querySelector("[data-prompt]")!.parentElement!.parentElement!;
    // Tall enough not to count as stuck to the bottom.
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    return scroller;
  }

  it("pins the prompt scrolled past, and none at the top", () => {
    renderSlot(events);
    expect(screen.queryByTitle("Jump to a prompt")).toBeNull();
    layout();
    const header = screen.getByTitle("Jump to a prompt");
    expect(header.textContent).toContain("second ask");
    expect(header.textContent).toContain("2/3");
  });

  it("lists prompts newest first, filters them, and jumps to one", async () => {
    renderSlot(events);
    const scroller = layout();
    await userEvent.click(screen.getByTitle("Jump to a prompt"));
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["3shot.png", "2second askhere", "1first ask"]);
    await userEvent.keyboard("first{Enter}");
    // Prompt 1 sits 500px above the transcript's top; 8px of headroom.
    expect(scroller.scrollTop).toBe(300 - 500 - 8);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("queued follow-ups", () => {
  const queued: AcpEvent[] = [
    READY,
    { kind: "userMessage", text: "first", attachments: [] },
    {
      kind: "followups",
      items: [
        { id: "1", text: "then run the tests", attachments: [] },
        { id: "2", text: "and lint", attachments: [{ kind: "file", path: "src/lib.rs" }] },
      ],
    },
  ];
  const composer = () => screen.getByRole("textbox") as HTMLTextAreaElement;

  it("lists them above the composer, next first", () => {
    renderSlot(queued);
    const list = screen.getByLabelText("Queued prompts");
    expect(list.textContent).toContain("Nextthen run the tests");
    expect(list.textContent).toContain("Queuedand lint");
  });

  it("removes one, and takes one back into the composer to edit", async () => {
    renderSlot(queued);
    await userEvent.click(screen.getAllByRole("button", { name: "Remove queued prompt" })[0]);
    expect(client.acpRemoveFollowup).toHaveBeenCalledWith("agent-1", "1");
    expect(composer().value).toBe("");

    vi.mocked(client.acpRemoveFollowup).mockResolvedValueOnce({
      id: "2",
      text: "and lint",
      attachments: [{ kind: "file", path: "src/lib.rs" }],
    });
    await userEvent.click(screen.getAllByRole("button", { name: "Edit queued prompt" })[1]);
    await waitFor(() => expect(composer().value).toBe("and lint"));
    expect(screen.getByTitle("src/lib.rs")).toBeTruthy();
    expect(screen.getByText(/Editing a queued prompt/)).toBeTruthy();
    // Sent back to its place (second), not the end.
    await userEvent.type(composer(), " too{Enter}");
    expect(client.acpSendPrompt).toHaveBeenCalledWith(
      "agent-1",
      "and lint too",
      [{ kind: "file", path: "src/lib.rs" }],
      false,
      1,
    );
  });

  it("puts the original back in its place when the edit is abandoned", async () => {
    vi.mocked(client.acpRemoveFollowup).mockResolvedValueOnce({
      id: "1",
      text: "then run the tests",
      attachments: [],
    });
    renderSlot(queued);
    await userEvent.type(composer(), "my draft");
    await userEvent.click(screen.getAllByRole("button", { name: "Edit queued prompt" })[0]);
    await waitFor(() => expect(composer().value).toBe("then run the tests"));
    await userEvent.type(composer(), " now{Escape}");
    expect(client.acpSendPrompt).toHaveBeenCalledWith("agent-1", "then run the tests", [], false, 0);
    expect(composer().value).toBe("my draft");
  });

  it("puts them back in the composer when the turn is stopped", async () => {
    vi.mocked(client.acpCancel).mockResolvedValueOnce([
      { id: "1", text: "then run the tests", attachments: [] },
      { id: "2", text: "and lint", attachments: [] },
    ]);
    renderSlot(queued);
    await userEvent.click(composer());
    await userEvent.keyboard("{Escape}");
    expect(client.acpCancel).toHaveBeenCalledWith("agent-1");
    await waitFor(() => expect(composer().value).toBe("then run the tests\n\nand lint"));
  });
});

describe("⌘F", () => {
  const events: AcpEvent[] = [
    READY,
    { kind: "userMessage", text: "check the cache", attachments: [] },
    {
      kind: "tool",
      tool: { ...toolCall("t1", "execute", "completed", "cargo test"), content: [{ kind: "text", text: "cache miss in lru.rs" }] },
    },
    { kind: "tool", tool: toolCall("t2", "read", "completed", "Read lru.rs", "/repo/lru.rs") },
    { kind: "agentText", text: "The cache is fine." },
    { kind: "turnEnded", stopReason: "end_turn" },
  ];

  it("finds text, opening folded tool output that matches", async () => {
    renderSlot(events);
    expect(screen.queryByText("cache miss in lru.rs")).toBeNull();
    await userEvent.click(screen.getByRole("textbox"));
    await userEvent.keyboard("{Meta>}f{/Meta}");
    const find = screen.getByLabelText("Find in transcript");
    expect(document.activeElement).toBe(find);
    await userEvent.keyboard("cache");
    expect(screen.getByText("cache miss in lru.rs")).toBeTruthy();
    // The prompt, the tool output, the reply.
    await waitFor(() => expect(screen.getByRole("search").textContent).toContain("1/3"));
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("search").textContent).toContain("2/3");
    await userEvent.keyboard("{Shift>}{Enter}{Enter}{/Shift}");
    expect(screen.getByRole("search").textContent).toContain("3/3");
  });

  it("closes with Esc and refolds", async () => {
    renderSlot(events);
    await userEvent.click(screen.getByRole("textbox"));
    await userEvent.keyboard("{Meta>}f{/Meta}cache{Escape}");
    expect(screen.queryByRole("search")).toBeNull();
    expect(screen.queryByText("cache miss in lru.rs")).toBeNull();
  });
});
