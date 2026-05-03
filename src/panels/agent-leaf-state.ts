import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

import {
  agentResize,
  agentWrite,
  attachAgent,
  killAgent,
  launchAgent,
} from "@/ipc/client";
import type {
  AgentBackendKind,
  AgentEvent,
  AgentSessionId,
  WorktreeId,
} from "@/ipc/types";
import { fitAndPin } from "./xterm-fit";
import { registerTerminalLinks } from "./term-path-links";
import { attachTerminalSearch } from "./term-search";

export type AgentLeafMode =
  | { kind: "launch"; backend: AgentBackendKind; argv?: string[] }
  | { kind: "attach"; agentId: AgentSessionId };

export type AgentLeafState = {
  host: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  sessionId: AgentSessionId | null;
  resizeObserver: ResizeObserver | null;
  links: { dispose: () => void } | null;
  killed: boolean;
  error: string | null;
  errorListeners: Set<(err: string | null) => void>;
};

/// Per-worktree pool keyed initially by the React tab's `localId` (for
/// in-flight launches) and re-keyed to `AgentSessionId` once the session
/// arrives. Survives `AgentTabs` unmount/remount on worktree switch so
/// the xterm scrollback, scroll position, selection, and search state
/// aren't blown away — the live PTY ring-buffer replay only restores
/// bytes, not viewport state.
const poolByWorktree = new Map<WorktreeId, Map<string, AgentLeafState>>();

export function getAgentLeafStates(
  worktreeId: WorktreeId,
): Map<string, AgentLeafState> {
  let m = poolByWorktree.get(worktreeId);
  if (!m) {
    m = new Map();
    poolByWorktree.set(worktreeId, m);
  }
  return m;
}

export function rekeyAgentLeafState(
  worktreeId: WorktreeId,
  oldKey: string,
  newKey: string,
): void {
  if (oldKey === newKey) return;
  const m = poolByWorktree.get(worktreeId);
  if (!m) return;
  const state = m.get(oldKey);
  if (!state) return;
  m.delete(oldKey);
  m.set(newKey, state);
}

/// Drop pool entries whose underlying agent is no longer running, plus
/// any pre-session orphans left by a previous `AgentTabs` lifetime that
/// got unmounted before its launch resolved. Called from the adoption
/// pass on worktree-mount.
export function reconcileAgentLeafStates(
  worktreeId: WorktreeId,
  aliveAgentIds: Set<AgentSessionId>,
): void {
  const m = poolByWorktree.get(worktreeId);
  if (!m) return;
  for (const [key, state] of m) {
    const dropOrphan = state.sessionId === null;
    const dropDead =
      state.sessionId !== null && !aliveAgentIds.has(state.sessionId);
    if (dropOrphan || dropDead) {
      detachAgentLeafState(state);
      m.delete(key);
    }
  }
}

export function clearAgentLeafStatesForWorktree(
  worktreeId: WorktreeId,
): void {
  const m = poolByWorktree.get(worktreeId);
  if (!m) return;
  for (const state of m.values()) {
    disposeAgentLeafState(state);
  }
  m.clear();
  poolByWorktree.delete(worktreeId);
}

export function createAgentLeafState(
  worktreeId: WorktreeId,
  mode: AgentLeafMode,
  onSession: (id: AgentSessionId) => void,
): AgentLeafState {
  const host = document.createElement("div");
  host.style.position = "absolute";
  host.style.inset = "0";
  host.style.padding = "8px";
  host.style.boxSizing = "border-box";

  const term = new Terminal({
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    theme: {
      background: "#121314",
      foreground: "#BBBEBF",
      cursor: "#BBBEBF",
    },
    cursorBlink: true,
    scrollback: 20_000,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // Cmd+click on file paths opens them in the editor; on URLs, in the
  // system browser.
  const termLinks = registerTerminalLinks(term, worktreeId);
  // Cmd+F overlay search.
  const search = attachTerminalSearch(term, host);

  const state: AgentLeafState = {
    host,
    term,
    fit,
    sessionId: null,
    resizeObserver: null,
    links: {
      dispose() {
        termLinks.dispose();
        search.dispose();
      },
    },
    killed: false,
    error: null,
    errorListeners: new Set(),
  };

  const setError = (err: string | null) => {
    state.error = err;
    for (const cb of state.errorListeners) cb(err);
  };

  const encoder = new TextEncoder();
  const onEvent = (ev: AgentEvent) => {
    if (state.killed) return;
    if (ev.kind === "data") {
      term.write(new Uint8Array(ev.bytes));
    } else if (ev.kind === "status") {
      if (ev.status.kind === "exited" || ev.status.kind === "crashed") {
        const suffix =
          ev.status.kind === "exited"
            ? ev.status.code !== null
              ? ` (code ${ev.status.code})`
              : ""
            : `: ${ev.status.message}`;
        term.write(
          `\r\n\x1b[38;2;140;140;140m[agent ${ev.status.kind}${suffix}]\x1b[0m\r\n`,
        );
      }
    }
  };

  (async () => {
    try {
      let id: AgentSessionId;
      if (mode.kind === "launch") {
        const s = await launchAgent(
          worktreeId,
          mode.backend,
          term.cols,
          term.rows,
          onEvent,
          mode.argv,
        );
        id = s.id;
        // disposeAgentLeafState fired while launchAgent was in flight —
        // explicit close before the session ID came back. Kill the
        // orphan PTY so it doesn't reappear as a phantom adopted tab on
        // the next worktree visit.
        if (state.killed) {
          await killAgent(id).catch(() => {});
          return;
        }
      } else {
        const s = await attachAgent(mode.agentId, onEvent);
        id = s.id;
        if (state.killed) return;
      }
      state.sessionId = id;
      onSession(id);

      term.onData((data) => {
        if (state.sessionId && !state.killed) {
          agentWrite(state.sessionId, encoder.encode(data)).catch(() => {});
        }
      });
      // xterm collapses Shift+Enter to plain `\r` by default, so agents
      // submit instead of inserting a newline. Intercept and emit the
      // alt+enter sequence (ESC + CR) — the convention readline /
      // Ink-based TUIs (Claude Code, Codex) respect as "literal newline"
      // regardless of continuation-mode state. preventDefault is load-
      // bearing: returning false suppresses xterm's keydown handling but
      // the hidden-textarea browser default would still fire, inserting
      // a stray `\n` that confuses the TUI.
      term.attachCustomKeyEventHandler((ev) => {
        if (search.tryHandleKey(ev)) return false;
        if (ev.type === "keydown" && ev.key === "Enter" && ev.shiftKey) {
          ev.preventDefault();
          if (state.sessionId && !state.killed) {
            agentWrite(state.sessionId, encoder.encode("\x1b\r")).catch(
              () => {},
            );
          }
          return false;
        }
        return true;
      });
      term.onResize(({ cols, rows }) => {
        if (state.sessionId && !state.killed) {
          agentResize(state.sessionId, cols, rows).catch(() => {});
        }
      });
      state.resizeObserver = new ResizeObserver(() => {
        fitAndPin(fit, term);
      });
      state.resizeObserver.observe(host);
    } catch (e: unknown) {
      const msg =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      setError(msg);
    }
  })();

  return state;
}

/// Tear down xterm AND kill the agent. Called on explicit tab close.
export function disposeAgentLeafState(state: AgentLeafState): void {
  state.killed = true;
  state.resizeObserver?.disconnect();
  state.links?.dispose();
  state.term.dispose();
  if (state.sessionId) {
    killAgent(state.sessionId).catch(() => {});
  }
}

/// Tear down xterm without killing the agent. Used when reconcile finds
/// the session is already gone on the Rust side, or to drop a pre-
/// session orphan whose React tree is gone.
export function detachAgentLeafState(state: AgentLeafState): void {
  state.killed = true;
  state.resizeObserver?.disconnect();
  state.links?.dispose();
  state.term.dispose();
}
