import { describe, expect, it } from "vitest";
import type { TerminalCommand, TerminalId } from "@/ipc/types";
import { commandLabel, formatElapsed, rowCommand } from "./terminal-command";

describe("commandLabel", () => {
  it.each([
    ["docker build --platform linux/amd64 -t registry.example.com/ci:latest .", "docker build"],
    ["cargo test --quiet -p treehouse", "cargo test"],
    ["npm run dev -- --port 5173", "npm run dev"],
    ["docker compose up -d", "docker compose up"],
    ["RUST_LOG=debug cargo run", "cargo run"],
    ["sudo nohup make install", "make install"],
    ["./scripts/build.sh --release", "build.sh"],
    ["/usr/bin/python3 -m http.server", "python3"],
    ["npm install && npm test", "npm install"],
    ["tail -f log.txt | grep ERROR", "tail"],
    ["vim", "vim"],
    ["", ""],
  ])("%s → %s", (line, label) => {
    expect(commandLabel(line)).toBe(label);
  });
});

describe("formatElapsed", () => {
  it.each([
    [800, "0s"],
    [8_000, "8s"],
    [192_000, "3:12"],
    [3_849_000, "1:04:09"],
  ])("%d → %s", (ms, out) => {
    expect(formatElapsed(ms)).toBe(out);
  });
});

function cmd(
  id: string,
  startedAt: number,
  finishedAt: number | null = null,
  exitCode: number | null = null,
): TerminalCommand {
  return {
    terminalId: id as TerminalId,
    command: id,
    startedAt,
    finishedAt,
    exitCode,
  };
}

describe("rowCommand", () => {
  const now = 100_000;

  it("shows the longest-running command and counts the rest", () => {
    const r = rowCommand([cmd("b", 90_000), cmd("a", 10_000), cmd("c", 50_000)], now);
    expect(r?.command.command).toBe("a");
    expect(r?.othersRunning).toBe(2);
  });

  it("hides a command that only just started", () => {
    expect(rowCommand([cmd("ls", now - 500)], now)).toBeNull();
  });

  it("prefers running over finished", () => {
    const r = rowCommand([cmd("done", 0, 50_000, 0), cmd("run", 90_000)], now);
    expect(r?.command.command).toBe("run");
  });

  it("shows the latest long finished command, skipping short ones", () => {
    const r = rowCommand(
      [cmd("old", 0, 20_000, 0), cmd("new", 30_000, 60_000, 1), cmd("quick", 70_000, 71_000, 0)],
      now,
    );
    expect(r?.command.command).toBe("new");
  });
});
