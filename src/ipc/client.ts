import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentBackendKind,
  AgentEvent,
  AgentSession,
  AgentSessionId,
  Comment,
  CreateWorktreeResult,
  DiffSet,
  FileContent,
  LspConfig,
  LspEvent,
  LspServerId,
  LspServerSession,
  MergeResult,
  MergeBackStrategy,
  SyncResult,
  SyncStrategy,
  PtyEvent,
  RecentWorkspace,
  Settings,
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

export function closeWorkspace(workspaceId: WorkspaceId): Promise<void> {
  return invoke<void>("close_workspace", { workspaceId });
}

export function listRecentWorkspaces(): Promise<RecentWorkspace[]> {
  return invoke<RecentWorkspace[]>("list_recent_workspaces");
}

export function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

export function updateSettings(settings: Settings): Promise<Settings> {
  return invoke<Settings>("update_settings", { settings });
}

export function listComments(): Promise<Comment[]> {
  return invoke<Comment[]>("list_comments");
}

export function saveComments(comments: Comment[]): Promise<Comment[]> {
  return invoke<Comment[]>("save_comments", { comments });
}

// --- Worktrees ---

export function listWorktrees(workspaceId: WorkspaceId): Promise<Worktree[]> {
  return invoke<Worktree[]>("list_worktrees", { workspaceId });
}

export function createWorktree(
  workspaceId: WorkspaceId,
  name: string,
  opts: { initSubmodules?: boolean } = {},
): Promise<CreateWorktreeResult> {
  return invoke<CreateWorktreeResult>("create_worktree", {
    workspaceId,
    name,
    initSubmodules: opts.initSubmodules ?? false,
  });
}

export function removeWorktree(
  worktreeId: WorktreeId,
  force: boolean = false,
): Promise<void> {
  return invoke<void>("remove_worktree", { worktreeId, force });
}

export function mergeWorktree(
  worktreeId: WorktreeId,
  strategy: MergeBackStrategy,
  commitMessage?: string,
): Promise<MergeResult> {
  return invoke<MergeResult>("merge_worktree", {
    worktreeId,
    strategy,
    commitMessage: commitMessage ?? null,
  });
}

export function syncWorktree(
  worktreeId: WorktreeId,
  strategy: SyncStrategy,
): Promise<SyncResult> {
  return invoke<SyncResult>("sync_worktree", { worktreeId, strategy });
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
  showIgnored: boolean = false,
): Promise<TreeEntry[]> {
  return invoke<TreeEntry[]>("list_tree", { worktreeId, dir, showIgnored });
}

/// Read a file's content at a specific git ref via `git show <ref>:<path>`.
/// Returns "" if the path didn't exist at that ref.
export function readBlobAtRef(
  worktreeId: WorktreeId,
  path: string,
  reference: string,
): Promise<string> {
  return invoke<string>("read_blob_at_ref", { worktreeId, path, reference });
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

export function attachTerminal(
  terminalId: TerminalId,
  onEvent: (ev: PtyEvent) => void,
): Promise<TerminalSession> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = onEvent;
  return invoke<TerminalSession>("attach_terminal", { terminalId, channel });
}

export function listTerminalsForWorktree(
  worktreeId: WorktreeId,
): Promise<TerminalSession[]> {
  return invoke<TerminalSession[]>("list_terminals_for_worktree", {
    worktreeId,
  });
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

export function listAgentsForWorktree(
  worktreeId: WorktreeId,
): Promise<AgentSession[]> {
  return invoke<AgentSession[]>("list_agents_for_worktree", { worktreeId });
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

// --- LSP ---

/**
 * Spawn (or reattach to) an LSP server for `(worktreeId, languageId)`.
 * `filePath` is the absolute path of the file being opened — used for
 * workspace-root resolution via the language's `rootMarkers`.
 */
export function lspEnsure(
  worktreeId: WorktreeId,
  languageId: string,
  filePath: string,
  onEvent: (ev: LspEvent) => void,
): Promise<LspServerSession> {
  const channel = new Channel<LspEvent>();
  channel.onmessage = onEvent;
  return invoke<LspServerSession>("lsp_ensure", {
    worktreeId,
    languageId,
    filePath,
    channel,
  });
}

export function lspWrite(
  serverId: LspServerId,
  data: Uint8Array,
): Promise<void> {
  return invoke<void>("lsp_write", { serverId, data: Array.from(data) });
}

export function lspKill(serverId: LspServerId): Promise<void> {
  return invoke<void>("lsp_kill", { serverId });
}

export function lspList(
  worktreeId?: WorktreeId,
): Promise<LspServerSession[]> {
  return invoke<LspServerSession[]>("lsp_list", {
    worktreeId: worktreeId ?? null,
  });
}

export function lspListConfigs(): Promise<LspConfig[]> {
  return invoke<LspConfig[]>("lsp_list_configs");
}

export function lspSaveConfig(config: LspConfig): Promise<LspConfig[]> {
  return invoke<LspConfig[]>("lsp_save_config", { config });
}

export function lspResolveCommand(command: string): Promise<string | null> {
  return invoke<string | null>("lsp_resolve_command", { command });
}

export function onLspServersChanged(
  workspaceId: WorkspaceId,
  handler: () => void,
): Promise<UnlistenFn> {
  return listen(`workspace://${workspaceId}/lsp-servers-changed`, handler);
}
