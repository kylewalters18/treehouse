import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/ipc/client", () => ({
  listFiles: vi.fn(async () => ["src/lib.rs", "src/main.rs", "README.md"]),
}));

import { AcpPromptBox } from "./AcpPromptBox";
import type { AcpCommand } from "@/ipc/types";

const COMMANDS: AcpCommand[] = [
  { name: "compact", description: "Compact the context", hint: null },
  { name: "review", description: "Review a PR", hint: "PR number" },
];

function setup() {
  const onSend = vi.fn(async () => true);
  render(
    <AcpPromptBox
      worktreeId="wt-1"
      commands={COMMANDS}
      canSend
      disabled={false}
      running={false}
      imagesAllowed
      onSend={onSend}
      onCancel={() => {}}
      focusNonce={0}
    />,
  );
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  return { input, onSend };
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
    ]);
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
