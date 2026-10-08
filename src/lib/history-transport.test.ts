import { describe, expect, it } from "vitest";
import type { AgentHistoryEntry } from "@/ipc/types";
import { offersTerminal, preferredTransport } from "./history-transport";

const entry = (over: Partial<AgentHistoryEntry>): AgentHistoryEntry => ({
  sessionId: "s",
  backend: "claudeCode",
  title: null,
  lastMessage: null,
  startedAt: 0,
  lastActiveAt: 0,
  liveAgentId: null,
  transports: ["acp", "pty"],
  ...over,
});

describe("history transports", () => {
  it("reopens Claude over ACP with a terminal option", () => {
    const e = entry({});
    expect(preferredTransport(e)).toBe("acp");
    expect(offersTerminal(e)).toBe(true);
  });

  it("reopens Codex and Kiro ACP sessions over ACP only", () => {
    const e = entry({ backend: "codex", transports: ["acp"] });
    expect(preferredTransport(e)).toBe("acp");
    expect(offersTerminal(e)).toBe(false);
  });

  it("reopens Kiro terminal conversations in a terminal", () => {
    const e = entry({ backend: "kiro", transports: ["pty"] });
    expect(preferredTransport(e)).toBe("pty");
    expect(offersTerminal(e)).toBe(false);
  });
});
