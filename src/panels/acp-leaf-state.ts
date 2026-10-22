import { attachAgent, killAgent, launchAgent, openPlanner } from "@/ipc/client";
import type { AgentEvent, AgentSessionId, WorktreeId } from "@/ipc/types";
import { applyAcpEvent, emptyTranscript, type AcpTranscript } from "@/lib/acp-transcript";
import type { AgentLeafMode } from "./agent-leaf-state";
import { emptyComposerStash, type AcpComposerStash } from "./AcpPromptBox";

/// One ACP agent tab's client state: the transcript folded from the
/// session's event stream. The ACP counterpart of `AgentLeafState` (which
/// owns an xterm); pooled the same way so worktree switches keep it, and a
/// fresh attach replays the Rust-side event log into an empty transcript.
export type AcpLeafState = {
  sessionId: AgentSessionId | null;
  transcript: AcpTranscript;
  /// Bumped on every change; `useSyncExternalStore` snapshot.
  version: number;
  listeners: Set<() => void>;
  exited: boolean;
  error: string | null;
  killed: boolean;
  /// The composer's unsent draft, so a worktree switch doesn't drop it.
  composer: AcpComposerStash;
  /// When the running turn started (ms epoch), seen live; null when idle
  /// or when the turn was already running at attach (start unknown).
  turnStartedAt: number | null;
  /// When the last event arrived, to tell a quiet agent from a busy one.
  lastEventAt: number;
};

const poolByWorktree = new Map<WorktreeId, Map<string, AcpLeafState>>();

export function getAcpLeafStates(worktreeId: WorktreeId): Map<string, AcpLeafState> {
  let m = poolByWorktree.get(worktreeId);
  if (!m) {
    m = new Map();
    poolByWorktree.set(worktreeId, m);
  }
  return m;
}

export function rekeyAcpLeafState(worktreeId: WorktreeId, oldKey: string, newKey: string): void {
  const m = poolByWorktree.get(worktreeId);
  const state = m?.get(oldKey);
  if (!m || !state || oldKey === newKey) return;
  m.delete(oldKey);
  m.set(newKey, state);
}

/// Drop entries whose agent is gone and pre-session orphans; see
/// `reconcileAgentLeafStates`.
export function reconcileAcpLeafStates(
  worktreeId: WorktreeId,
  aliveAgentIds: Set<AgentSessionId>,
): void {
  const m = poolByWorktree.get(worktreeId);
  if (!m) return;
  for (const [key, state] of m) {
    if (state.sessionId === null || !aliveAgentIds.has(state.sessionId)) {
      state.killed = true;
      m.delete(key);
    }
  }
}

export function clearAcpLeafStatesForWorktree(worktreeId: WorktreeId): void {
  const m = poolByWorktree.get(worktreeId);
  if (!m) return;
  for (const state of m.values()) disposeAcpLeafState(state);
  poolByWorktree.delete(worktreeId);
}

function notify(state: AcpLeafState) {
  state.version += 1;
  for (const cb of state.listeners) cb();
}

export function createAcpLeafState(
  worktreeId: WorktreeId,
  mode: AgentLeafMode,
  onSession: (id: AgentSessionId) => void,
): AcpLeafState {
  const state: AcpLeafState = {
    sessionId: null,
    transcript: emptyTranscript(),
    version: 0,
    listeners: new Set(),
    exited: false,
    error: null,
    killed: false,
    composer: emptyComposerStash(),
    turnStartedAt: null,
    lastEventAt: Date.now(),
  };

  const onEvent = (ev: AgentEvent) => {
    if (state.killed) return;
    switch (ev.kind) {
      case "acpBatch":
        // A (re)attach replays the whole log; start from scratch.
        state.transcript = emptyTranscript();
        for (const e of ev.events) applyAcpEvent(state.transcript, e);
        if (state.transcript.turns === 0) state.turnStartedAt = null;
        state.lastEventAt = Date.now();
        break;
      case "acp": {
        const before = state.transcript.turns;
        applyAcpEvent(state.transcript, ev.event);
        const after = state.transcript.turns;
        if (after === 0) state.turnStartedAt = null;
        else if (before === 0) state.turnStartedAt = Date.now();
        state.lastEventAt = Date.now();
        break;
      }
      case "status":
        state.exited = ev.status.kind === "exited" || ev.status.kind === "crashed";
        break;
      case "data":
        return;
    }
    notify(state);
  };

  (async () => {
    try {
      let id: AgentSessionId;
      if (mode.kind === "launch") {
        const s = await launchAgent(
          worktreeId,
          mode.backend,
          0,
          0,
          onEvent,
          mode.argv,
          mode.resume,
          mode.prompt,
          "acp",
        );
        id = s.id;
        if (state.killed) {
          await killAgent(id).catch(() => {});
          return;
        }
      } else if (mode.kind === "attach") {
        id = (await attachAgent(mode.agentId, onEvent)).id;
        if (state.killed) return;
      } else {
        const opened = await openPlanner(
          mode.workspaceId,
          0,
          0,
          onEvent,
          mode.resume,
          mode.prompt,
          "acp",
        );
        id = opened.session.id;
        mode.onCheckout?.(opened.checkout);
        // Closed while starting: the backend keeps the session (like a
        // PTY planner); "New session" kills it explicitly.
        if (state.killed) return;
      }
      state.sessionId = id;
      onSession(id);
      notify(state);
    } catch (e: unknown) {
      state.error =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      notify(state);
    }
  })();

  return state;
}

/// Stop rendering, leaving the agent running (a hidden planner).
export function detachAcpLeafState(state: AcpLeafState): void {
  state.killed = true;
  state.listeners.clear();
}

/// Stop rendering AND kill the agent. Called on explicit tab close.
export function disposeAcpLeafState(state: AcpLeafState): void {
  state.killed = true;
  state.listeners.clear();
  if (state.sessionId) killAgent(state.sessionId).catch(() => {});
}
