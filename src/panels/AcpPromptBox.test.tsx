import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/ipc/client", () => ({
  listFiles: vi.fn(async () => ["src/lib.rs", "src/main.rs", "README.md"]),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => ["/abs/notes.md"]),
}));

import { AcpPromptBox, emptyComposerStash, type AcpComposerStash } from "./AcpPromptBox";
import type { AcpCommand, AcpConfigOption } from "@/ipc/types";
import { composerControls } from "@/lib/acp-composer";

const opt = (id: string, category: string, current: string, values: [string, string][]): AcpConfigOption => ({
  id,
  name: id,
  description: null,
  category,
  current,
  options: values.map(([value, name]) => ({ value, name, description: null })),
});
const CONFIG = [
  opt("mode", "mode", "auto", [["default", "Manual"], ["plan", "Plan"], ["auto", "Auto"]]),
  opt("model", "model", "opus", [["opus", "Opus 5.5"], ["haiku", "Haiku 4.5"]]),
  opt("effort", "thought_level", "medium", [["low", "Low"], ["medium", "Medium"]]),
  opt("fast", "model_config", "off", [["on", "On"], ["off", "Off"]]),
];

const COMMANDS: AcpCommand[] = [
  { name: "compact", description: "Compact the context", hint: null },
  { name: "review", description: "Review a PR", hint: "PR number" },
];

const HISTORY = ["first prompt", "second prompt"];

function setup(
  overrides: Partial<{
    running: boolean;
    editRequest: { text: string; nonce: number } | null;
    insertRequest: { text: string; nonce: number } | null;
    narrow: boolean;
    stash: AcpComposerStash;
  }> = {},
) {
  const onSend = vi.fn(async () => true);
  const onSetting = vi.fn();
  const onCancel = vi.fn();
  const box = (o: typeof overrides) => (
    <AcpPromptBox
      worktreeId="wt-1"
      commands={COMMANDS}
      controls={composerControls(CONFIG, null)}
      usage={{ used: 50_000, size: 200_000, cost: null, currency: null }}
      onSetting={onSetting}
      canSend
      disabled={false}
      running={o.running ?? false}
      imagesAllowed
      onSend={onSend}
      onCancel={onCancel}
      focusNonce={0}
      history={HISTORY}
      editRequest={o.editRequest ?? null}
      narrow={o.narrow ?? false}
      insertRequest={o.insertRequest ?? null}
      stash={o.stash}
    />
  );
  const { rerender, unmount } = render(box(overrides));
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  return {
    input,
    onSend,
    onSetting,
    onCancel,
    unmount,
    rerender: (o: typeof overrides) => rerender(box(o)),
  };
}

describe("AcpPromptBox", () => {
  it("completes a slash command with Tab", async () => {
    const { input } = setup();
    await userEvent.type(input, "/rev");
    expect(screen.getByRole("option", { name: /review/ })).toBeTruthy();
    await userEvent.keyboard("{Tab}");
    expect(input.value).toBe("/review ");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("completes @files and sends them as attachments", async () => {
    const { input, onSend } = setup();
    await userEvent.type(input, "explain @lib");
    await waitFor(() => expect(screen.getByRole("option", { name: /src\/lib\.rs/ })).toBeTruthy());
    await userEvent.keyboard("{Enter}");
    expect(input.value).toBe("explain @src/lib.rs ");
    await userEvent.type(input, "and @nope{Enter}");
    // The list for `@nope` is empty, so Enter sends.
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("explain @src/lib.rs and @nope", [
      { kind: "file", path: "src/lib.rs" },
    ], false);
    expect(input.value).toBe("");
  });

  it("Esc dismisses suggestions without clearing the draft", async () => {
    const { input } = setup();
    await userEvent.type(input, "/co");
    expect(screen.getByRole("listbox")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.value).toBe("/co");
  });
});

describe("AcpPromptBox toolbar", () => {
  it("shows current settings and picks a model", async () => {
    const { onSetting } = setup();
    await userEvent.click(screen.getByTitle("Model"));
    await userEvent.click(screen.getByRole("option", { name: /Haiku 4\.5/ }));
    expect(onSetting).toHaveBeenCalledWith(expect.objectContaining({ via: "config" }), "haiku");
    expect(onSetting.mock.calls[0][0].option.id).toBe("model");
    expect(screen.getByTitle("Reasoning effort").textContent).toContain("Medium");
    expect(screen.getByLabelText("Context 25% used")).toBeTruthy();
  });

  it("toggles fast and plan mode", async () => {
    const { onSetting } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Fast mode off" }));
    expect(onSetting).toHaveBeenLastCalledWith(expect.anything(), "on");
    await userEvent.click(screen.getByRole("button", { name: /^Plan mode:/ }));
    expect(onSetting.mock.lastCall?.[0].option.id).toBe("mode");
    expect(onSetting).toHaveBeenLastCalledWith(expect.anything(), "plan");
  });

  it("attaches files from disk and sends them", async () => {
    const { onSend } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Attach files or images" }));
    expect(await screen.findByText("notes.md")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("", [{ kind: "file", path: "/abs/notes.md" }], false));
  });
});

describe("AcpPromptBox history, interrupt, and editing", () => {
  it("walks sent prompts with ↑/↓ and restores the draft", async () => {
    const { input } = setup();
    await userEvent.click(input);
    await userEvent.keyboard("{ArrowUp}");
    expect(input.value).toBe("second prompt");
    await userEvent.keyboard("{ArrowUp}");
    expect(input.value).toBe("first prompt");
    await userEvent.keyboard("{ArrowUp}");
    expect(input.value).toBe("first prompt");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(input.value).toBe("");
  });

  it("leaves ↑ alone when there's a draft", async () => {
    const { input } = setup();
    await userEvent.type(input, "draft{ArrowUp}");
    expect(input.value).toBe("draft");
  });

  it("⏎ queues mid-turn; ⌘⏎ and the Interrupt button interrupt", async () => {
    const { input, onSend } = setup({ running: true });
    await userEvent.type(input, "later{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("later", [], false));
    await userEvent.type(input, "now{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("now", [], true));
    await userEvent.type(input, "redirect");
    await userEvent.click(screen.getByRole("button", { name: /Interrupt/ }));
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("redirect", [], true));
  });

  it("edits a sent prompt: resend interrupts, Esc puts the draft back", async () => {
    const { input, onSend, rerender } = setup({ running: true });
    await userEvent.type(input, "half-typed");
    rerender({ running: true, editRequest: { text: "fix the bug", nonce: 1 } });
    expect(input.value).toBe("fix the bug");
    expect(screen.getByText(/Editing a sent message/)).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(input.value).toBe("half-typed");
    expect(screen.queryByText(/Editing a sent message/)).toBeNull();

    rerender({ running: true, editRequest: { text: "fix the bug", nonce: 2 } });
    await userEvent.type(input, " properly{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("fix the bug properly", [], true));
  });
});

describe("AcpPromptBox ⌃C", () => {
  it("clears the draft when idle", async () => {
    const { input, onCancel } = setup();
    await userEvent.type(input, "never mind");
    await userEvent.keyboard("{Control>}c{/Control}");
    expect(input.value).toBe("");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps the draft while running (the slot interrupts)", async () => {
    const { input } = setup({ running: true });
    await userEvent.type(input, "next");
    await userEvent.keyboard("{Control>}c{/Control}");
    expect(input.value).toBe("next");
  });
});

describe("AcpPromptBox narrow", () => {
  it("shows pickers as icons with the value in the tooltip, and drops Interrupt", async () => {
    const { input, onSetting } = setup({ narrow: true, running: true });
    const model = screen.getByTitle("Model: Opus 5.5");
    expect(model.textContent).toBe("");
    await userEvent.type(input, "next");
    expect(screen.queryByRole("button", { name: /Interrupt/ })).toBeNull();
    // The list still opens and picks.
    await userEvent.click(model);
    await userEvent.click(screen.getByRole("option", { name: /Haiku 4\.5/ }));
    expect(onSetting).toHaveBeenCalledWith(expect.objectContaining({ via: "config" }), "haiku");
  });
});

describe("AcpPromptBox inserts", () => {
  it("appends inserted text, but not a request that predates mount", async () => {
    const { input, rerender } = setup({ insertRequest: { text: "#1 Old ", nonce: 1 } });
    expect(input.value).toBe("");
    await userEvent.type(input, "look at");
    rerender({ insertRequest: { text: "#42 Fix login ", nonce: 2 } });
    expect(input.value).toBe("look at #42 Fix login ");
  });
});

describe("AcpPromptBox stash", () => {
  it("keeps the unsent draft across a remount, and clears it once sent", async () => {
    const stash = emptyComposerStash();
    const first = setup({ stash });
    await userEvent.type(first.input, "half a thought");
    first.unmount();
    const second = setup({ stash });
    expect(second.input.value).toBe("half a thought");
    await userEvent.type(second.input, "{Enter}");
    expect(second.onSend).toHaveBeenCalled();
    expect(stash.draft).toBe("");
  });
});
