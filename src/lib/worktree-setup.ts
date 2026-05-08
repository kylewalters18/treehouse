/// Worktree post-create hook: fetches the resolved setup steps from
/// the Rust side, stitches them into a shell script, and opens a
/// terminal tab in the new worktree that runs the script. The user
/// sees output live and lands at an interactive prompt afterward.
///
/// Skip-flag is honored upstream — this module assumes the caller
/// already decided to run setup. No-op when no steps are configured.

import { worktreeSetupSteps } from "@/ipc/client";
import type { OnCreateStep, WorktreeId } from "@/ipc/types";
import { makeLeaf } from "@/panels/pane-tree";
import { useTerminalLayoutStore } from "@/stores/terminal-layout";

/// Stitches `steps` into a single-line zsh-compatible script. Wraps
/// the user's commands in a subshell with `set -e` so the chain
/// stops at the first non-zero exit; the outer shell stays alive
/// either way so the user can investigate output. Marks setup as
/// successful (best-effort) when the chain completes.
export function buildSetupScript(steps: OnCreateStep[]): string {
  if (steps.length === 0) return "";
  const inner = steps
    .map((step) => {
      const banner = `echo ${shellEscape(`==> ${step.name}`)}`;
      const envPrefix = Object.entries(step.env)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([k, v]) => `${shellEscape(k)}=${shellEscape(v)}`)
        .join(" ");
      const argv = [step.command, ...step.args].map(shellEscape).join(" ");
      const exec = envPrefix ? `${envPrefix} ${argv}` : argv;
      return `${banner} ; ${exec}`;
    })
    .join(" ; ");
  // Subshell isolates `set -e` and keeps the outer interactive shell
  // alive after the chain; `&&` / `||` print a final status line.
  return (
    `( set -e ; ${inner} ) ` +
    `&& echo ${shellEscape("==> Setup complete")} ` +
    `|| echo ${shellEscape("==> Setup failed at the previous step")}\n`
  );
}

/// POSIX-style single-quote escape. Conservative: chars outside a
/// safe set get wrapped in single quotes with embedded `'` escaped
/// as `'\''`. Good enough for paths, args, and env values; not a
/// full shellquote impl (we don't need backtick / `$()` handling
/// since users supply raw values, not shell expressions).
function shellEscape(s: string): string {
  if (s.length === 0) return "''";
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/// Run the post-create hook for a freshly-created worktree. Adds a
/// new terminal tab seeded with the setup script — TerminalPane
/// mounts it on the user's next visit (or immediately if they're
/// already on the worktree). Marker write happens optimistically
/// after the tab is queued; we don't wait for the script to actually
/// finish since the renderer has no clean exit-code feedback yet.
export async function runWorktreeSetup(
  worktreeId: WorktreeId,
): Promise<void> {
  let steps: OnCreateStep[];
  try {
    steps = await worktreeSetupSteps(worktreeId);
  } catch (e) {
    console.warn("worktree setup: failed to load steps", e);
    return;
  }
  if (steps.length === 0) return;

  const script = buildSetupScript(steps);
  if (!script) return;

  useTerminalLayoutStore.getState().updateLayout(worktreeId, (prev) => {
    const counter = prev.counter + 1;
    const leaf = makeLeaf({ kind: "open", initInput: script });
    const tab = {
      localId: crypto.randomUUID(),
      label: "setup",
      tree: leaf,
      activeLeafId: leaf.localId,
    };
    return {
      tabs: [...prev.tabs, tab],
      activeTabId: tab.localId,
      counter,
    };
  });
  // No success marker yet — the PTY transport doesn't surface a
  // structured "script finished, exit=0" signal we can consume. The
  // `worktreeMarkSetupRan` IPC + breadcrumb file at
  // `<worktree>/.treehouse/setup-ran` exist for a future iteration
  // that watches the terminal scrollback (or a sentinel echo) and
  // records completion.
}
