/// Display helpers for terminal commands reported by shell integration
/// (`TerminalCommand`): a short label for the sidebar, elapsed times, and
/// which command a worktree row should show.

import type { TerminalCommand } from "@/ipc/types";
import { splitCommand } from "@/lib/shell-words";

/// Prefixes that wrap the command worth naming.
const WRAPPERS = new Set(["sudo", "time", "nohup", "exec", "command", "env", "caffeinate"]);

/// Tools whose first argument is a subcommand worth naming
/// (`docker build`, `cargo test`).
const SUBCOMMAND_TOOLS = new Set([
  "brew", "bun", "bundle", "cargo", "deno", "docker", "docker-compose",
  "dotnet", "gh", "git", "glab", "go", "gradle", "helm", "kubectl", "make",
  "mix", "mvn", "npm", "npx", "pip", "pnpm", "podman", "poetry", "rails",
  "swift", "terraform", "uv", "yarn",
]);

/// Subcommands that are themselves a verb before the interesting word
/// (`npm run dev`, `docker compose up`, `uv run pytest`).
const SECOND_LEVEL = new Set(["run", "compose", "exec", "x"]);

/// "docker build --platform … -t ci ." → "docker build". Wrappers and
/// leading `VAR=value` assignments are skipped, only the first command of a
/// `&&` / `|` / `;` chain is named, and the program is shown by basename.
export function commandLabel(line: string): string {
  const first = line.split(/&&|\|\||[|;\n]/)[0] ?? "";
  const words = splitCommand(first.trim());
  let i = 0;
  while (
    i < words.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) ||
      WRAPPERS.has(words[i]) ||
      (i > 0 && WRAPPERS.has(words[i - 1]) && words[i].startsWith("-")))
  ) {
    i++;
  }
  if (i >= words.length) return line.trim();
  const program = words[i].split("/").pop() || words[i];
  const out = [program];
  if (SUBCOMMAND_TOOLS.has(program)) {
    const rest = words.slice(i + 1).filter((w) => !w.startsWith("-"));
    if (rest[0]) out.push(rest[0]);
    if (rest[0] && SECOND_LEVEL.has(rest[0]) && rest[1]) out.push(rest[1]);
  }
  return out.join(" ");
}

/// "8s", "3:12", "1:04:09".
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/// Running commands appear once they've run this long, so a quick `ls`
/// doesn't flash a status line into the row.
export const SHOW_RUNNING_AFTER_MS = 2_000;
/// A finished command stays on the row only if it ran at least this long.
export const SHOW_FINISHED_MIN_MS = 10_000;

export type RowCommand = {
  command: TerminalCommand;
  /// Other commands running in the worktree's terminals.
  othersRunning: number;
};

/// What a worktree row's status line shows: the longest-running command
/// (with a count of the rest), else the most recent finished command that
/// ran long enough to be worth reporting.
export function rowCommand(
  commands: TerminalCommand[],
  now: number,
): RowCommand | null {
  const running = commands
    .filter((c) => c.finishedAt == null && now - c.startedAt >= SHOW_RUNNING_AFTER_MS)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (running.length > 0) {
    return { command: running[0], othersRunning: running.length - 1 };
  }
  const finished = commands
    .filter(
      (c) => c.finishedAt != null && c.finishedAt - c.startedAt >= SHOW_FINISHED_MIN_MS,
    )
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  return finished[0] ? { command: finished[0], othersRunning: 0 } : null;
}

export function isRunning(c: TerminalCommand): boolean {
  return c.finishedAt == null;
}
