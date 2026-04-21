import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentBackendKind,
  AgentEvent,
  AgentSession,
  AgentSessionId,
  DiffSet,
  FileContent,
  MergeResult,
  PtyEvent,
  RecentWorkspace,
  TerminalId,
  TerminalSession,
  TreeEntry,
  Workspace,
  WorkspaceId,
  Worktree,
  WorktreeActivity,
  WorktreeId,
} from "./types";

// --- Workspace ---

export function openWorkspace(path: string): Promise<Workspace> {
  return invoke<Workspace>("open_workspace", { path });
}

export function listRecentWorkspaces(): Promise<RecentWorkspace[]> {
  return invoke<RecentWorkspace[]>("list_recent_workspaces");
}

// --- Worktrees ---

export function listWorktrees(workspaceId: WorkspaceId): Promise<Worktree[]> {
  return invoke<Worktree[]>("list_worktrees", { workspaceId });
}

export function createWorktree(
  workspaceId: WorkspaceId,
  name: string,
): Promise<Worktree> {
  return invoke<Worktree>("create_worktree", { workspaceId, name });
}

export function removeWorktree(
  worktreeId: WorktreeId,
  force: boolean = false,
): Promise<void> {
  return invoke<void>("remove_worktree", { worktreeId, force });
}

export function mergeWorktree(worktreeId: WorktreeId): Promise<MergeResult> {
  return invoke<MergeResult>("merge_worktree", { worktreeId });
}

export function onWorktreesChanged(
  workspaceId: WorkspaceId,
  handler: () => void,
): Promise<UnlistenFn> {
  return listen(`workspace://${workspaceId}/worktrees-changed`, handler);
}

// --- Diffs ---

export function getDiff(worktreeId: WorktreeId): Promise<DiffSet> {
  return invoke<DiffSet>("get_diff", { worktreeId });
}

export function onDiffUpdated(
  worktreeId: WorktreeId,
  handler: (diff: DiffSet) => void,
): Promise<UnlistenFn> {
  return listen<DiffSet>(`diff://${worktreeId}/updated`, (ev) =>
    handler(ev.payload),
  );
}

// --- Files ---

export function readFile(
  worktreeId: WorktreeId,
  path: string,
): Promise<FileContent> {
  return invoke<FileContent>("read_file", { worktreeId, path });
}

export function listTree(
  worktreeId: WorktreeId,
  dir: string = "",
): Promise<TreeEntry[]> {
  return invoke<TreeEntry[]>("list_tree", { worktreeId, dir });
}

// --- Terminals ---

export function openTerminal(
  worktreeId: WorktreeId,
  cols: number,
  rows: number,
  onEvent: (ev: PtyEvent) => void,
  shell?: string,
): Promise<TerminalSession> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = onEvent;
  return invoke<TerminalSession>("open_terminal", {
    worktreeId,
    cols,
    rows,
    shell,
    channel,
  });
}

export function ptyWrite(
  terminalId: TerminalId,
  data: Uint8Array,
): Promise<void> {
  return invoke<void>("pty_write", { terminalId, data: Array.from(data) });
}

export function ptyResize(
  terminalId: TerminalId,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("pty_resize", { terminalId, cols, rows });
}

export function closeTerminal(terminalId: TerminalId): Promise<void> {
  return invoke<void>("close_terminal", { terminalId });
}

// --- Agents ---

export function launchAgent(
  worktreeId: WorktreeId,
  backend: AgentBackendKind,
  cols: number,
  rows: number,
  onEvent: (ev: AgentEvent) => void,
  argv?: string[],
): Promise<AgentSession> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  return invoke<AgentSession>("launch_agent", {
    worktreeId,
    backend,
    argv,
    cols,
    rows,
    channel,
  });
}

export function agentWrite(
  agentId: AgentSessionId,
  data: Uint8Array,
): Promise<void> {
  return invoke<void>("agent_write", { agentId, data: Array.from(data) });
}

export function agentResize(
  agentId: AgentSessionId,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("agent_resize", { agentId, cols, rows });
}

export function killAgent(agentId: AgentSessionId): Promise<void> {
  return invoke<void>("kill_agent", { agentId });
}

export function getAgentForWorktree(
  worktreeId: WorktreeId,
): Promise<AgentSession | null> {
  return invoke<AgentSession | null>("get_agent_for_worktree", { worktreeId });
}

export function attachAgent(
  agentId: AgentSessionId,
  onEvent: (ev: AgentEvent) => void,
): Promise<AgentSession> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  return invoke<AgentSession>("attach_agent", { agentId, channel });
}

export function listAgentActivity(
  workspaceId: WorkspaceId,
): Promise<WorktreeActivity[]> {
  return invoke<WorktreeActivity[]>("list_agent_activity", { workspaceId });
}
