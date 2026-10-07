import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  BranchRef,
  AgentBackendKind,
  AgentOverview,
  AgentProfile,
  AgentEvent,
  AgentSession,
  AgentTransport,
  AcpAdapterInfo,
  AgentHistoryEntry,
  AgentSessionId,
  AppFileContent,
  BackendAgent,
  BrowserBounds,
  BrowserNavigated,
  Comment,
  CreateWorktreeResult,
  DiffMode,
  BranchCommits,
  DiffSet,
  FileContent,
  HookRunSummary,
  HookStep,
  LspConfig,
  LspEvent,
  LspOverride,
  LspServerId,
  LspServerSession,
  WorktreeHooks,
  WorktreeHookEntry,
  AgentPatternsView,
  BackendPatterns,
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
  ForgeStatus,
  ForgeIssue,
  IssueStart,
  PlannerActivity,
  PlannerOpened,
  ForgeMr,
  ForgePipeline,
  ForgeJob,
  ForgeJobLog,
  ForgeThread,
  ForgeApproval,
  ReviewCommentInput,
} from "./types";

// --- Workspace ---

export function openWorkspace(path: string): Promise<Workspace> {
  return invoke<Workspace>("open_workspace", { path });
}

export function closeWorkspace(workspaceId: WorkspaceId): Promise<void> {
  return invoke<void>("close_workspace", { workspaceId });
}

/// Currently-open workspaces (multi-repo session). Used to hydrate
/// `useWorkspaceStore` on app mount and after the boot-time restore
/// emits `app://workspaces-restored`.
export function listWorkspaces(): Promise<Workspace[]> {
  return invoke<Workspace[]>("list_workspaces");
}

/// Branch refs (local + remote-tracking, e.g. `origin/main`) offered in the
/// Changes-pane base picker. Read-only; no fetch.
export function listBranches(workspaceId: WorkspaceId): Promise<string[]> {
  return invoke<string[]>("list_branches", { workspaceId });
}

/// Branches a new worktree can check out (local + `origin/*`, newest first).
/// `fetch` runs a best-effort `git fetch` first.
export function listCheckoutBranches(
  workspaceId: WorkspaceId,
  fetch: boolean,
): Promise<BranchRef[]> {
  return invoke<BranchRef[]>("list_checkout_branches", { workspaceId, fetch });
}

/// Set (or clear, with `null`) the base ref the Changes diff compares against
/// for this workspace. Returns the updated workspace; the Rust side also
/// recomputes every worktree's diff so the Changes list refreshes.
export function setWorkspaceBaseRef(
  workspaceId: WorkspaceId,
  baseRef: string | null,
): Promise<Workspace> {
  return invoke<Workspace>("set_workspace_base_ref", { workspaceId, baseRef });
}

export function listRecentWorkspaces(): Promise<RecentWorkspace[]> {
  return invoke<RecentWorkspace[]>("list_recent_workspaces");
}

/// One-shot event fired by the Rust setup() callback after it finishes
/// restoring the persisted open-workspaces set on launch. The renderer
/// listens for it on mount and (re)calls listWorkspaces() to hydrate
/// the store — handles the race where the renderer mounts before
/// restore completes.
export function onWorkspacesRestored(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen<void>("app://workspaces-restored", () => handler());
}

/// Open an http/https URL in the host's default browser. Backend
/// rejects other schemes; treat the rejection as a no-op rather than a
/// user-visible error.
export function openExternalUrl(url: string): Promise<void> {
  return invoke<void>("open_external_url", { url });
}

/// Preview browser (bottom-pane Browser tab): one native child webview
/// per worktree, laid over the tab's placeholder. See `browser` in Rust.
export function browserShow(
  worktreeId: WorktreeId,
  url: string,
  bounds: BrowserBounds,
): Promise<void> {
  return invoke<void>("browser_show", { worktreeId, url, bounds });
}

export function browserHide(): Promise<void> {
  return invoke<void>("browser_hide");
}

export function browserNavigate(worktreeId: WorktreeId, url: string): Promise<void> {
  return invoke<void>("browser_navigate", { worktreeId, url });
}

export function browserReload(worktreeId: WorktreeId): Promise<void> {
  return invoke<void>("browser_reload", { worktreeId });
}

export function browserClose(worktreeId: WorktreeId): Promise<void> {
  return invoke<void>("browser_close", { worktreeId });
}

/// Fires after every page load in any preview, with its current URL.
export function onBrowserNavigated(
  handler: (payload: BrowserNavigated) => void,
): Promise<UnlistenFn> {
  return listen<BrowserNavigated>("browser://navigated", (ev) => handler(ev.payload));
}

export function listPinnedWorktrees(): Promise<string[]> {
  return invoke<string[]>("list_pinned_worktrees");
}

/// Worktree path → linked forge issue number.
export function listIssueLinks(): Promise<Record<string, number>> {
  return invoke<Record<string, number>>("list_issue_links");
}

/// Link a worktree (by path) to an issue, or unlink with `null`.
export function setWorktreeIssue(
  path: string,
  issue: number | null,
): Promise<Record<string, number>> {
  return invoke<Record<string, number>>("set_worktree_issue", { path, issue });
}

export function setWorktreePinned(
  path: string,
  pinned: boolean,
): Promise<string[]> {
  return invoke<string[]>("set_worktree_pinned", { path, pinned });
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
  opts: { initSubmodules?: boolean; base?: string | null; issue?: IssueStart | null } = {},
): Promise<CreateWorktreeResult> {
  return invoke<CreateWorktreeResult>("create_worktree", {
    workspaceId,
    name,
    initSubmodules: opts.initSubmodules ?? false,
    base: opts.base ?? null,
    issue: opts.issue ?? null,
  });
}

export function removeWorktree(
  worktreeId: WorktreeId,
  force: boolean = false,
  skipHook: boolean = false,
): Promise<HookRunSummary> {
  return invoke<HookRunSummary>("remove_worktree", {
    worktreeId,
    force,
    skipHook,
  });
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

/// Subscribe to step transitions inside `worktree::manager::create`.
/// Payload is a short human-readable string like "Fetching from origin"
/// that the sidebar renders verbatim under the spinner.
export function onWorktreeCreateStep(
  workspaceId: WorkspaceId,
  handler: (step: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(
    `workspace://${workspaceId}/worktree-create-step`,
    (ev) => handler(ev.payload),
  );
}

// --- Diffs ---

export function getDiff(
  worktreeId: WorktreeId,
  mode?: DiffMode,
): Promise<DiffSet> {
  return invoke<DiffSet>("get_diff", { worktreeId, mode });
}

export function listBranchCommits(
  worktreeId: WorktreeId,
): Promise<BranchCommits> {
  return invoke<BranchCommits>("list_branch_commits", { worktreeId });
}

export function getCommitDiff(
  worktreeId: WorktreeId,
  sha: string,
): Promise<DiffSet> {
  return invoke<DiffSet>("get_commit_diff", { worktreeId, sha });
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

/// Raw bytes of a worktree file (binary IPC response, not JSON). Used by
/// the markdown preview to load relative images.
export function readFileBytes(
  worktreeId: WorktreeId,
  path: string,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_file_bytes", { worktreeId, path });
}

/// Write `content` to a worktree-relative path, truncating any existing
/// file. The Rust side runs a write-flavored sandbox check (canonicalizes
/// the *parent*, since the file may not exist yet) and rejects paths
/// outside the worktree. Used by editor write-back (Cmd+S).
export function writeFile(
  worktreeId: WorktreeId,
  path: string,
  content: string,
): Promise<void> {
  return invoke<void>("write_file", { worktreeId, path, content });
}

export function listTree(
  worktreeId: WorktreeId,
  dir: string = "",
  showIgnored: boolean = false,
): Promise<TreeEntry[]> {
  return invoke<TreeEntry[]>("list_tree", { worktreeId, dir, showIgnored });
}

/// Recursive flat list of files in the worktree. Used by the Cmd+P
/// fuzzy file finder. Worktree-relative paths, forward-slash separated,
/// lex-sorted. `showIgnored` toggles whether `.gitignore` rules apply
/// — `BUILTIN_IGNORES` (`.git`, `node_modules`, …) always applies.
export function listFiles(
  worktreeId: WorktreeId,
  showIgnored: boolean = false,
): Promise<string[]> {
  return invoke<string[]>("list_files", { worktreeId, showIgnored });
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

export function listBackendAgents(
  backend: AgentBackendKind,
  worktreeId: WorktreeId | null,
): Promise<BackendAgent[]> {
  return invoke<BackendAgent[]>("list_backend_agents", {
    backend,
    worktreeId,
  });
}

export function launchAgent(
  worktreeId: WorktreeId,
  backend: AgentBackendKind,
  cols: number,
  rows: number,
  onEvent: (ev: AgentEvent) => void,
  argv?: string[],
  resume?: string,
  prompt?: string,
  /// `"acp"` launches via the backend's ACP adapter; `argv` then overrides
  /// the adapter command.
  transport?: AgentTransport,
): Promise<AgentSession> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  return invoke<AgentSession>("launch_agent", {
    worktreeId,
    backend,
    argv,
    prompt,
    resume,
    transport: transport ?? null,
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

/// Saved Claude conversations in a worktree, newest first.
export function listAgentHistory(
  worktreeId: WorktreeId,
): Promise<AgentHistoryEntry[]> {
  return invoke<AgentHistoryEntry[]>("list_agent_history", { worktreeId });
}

export function forgetAgentSession(sessionId: string): Promise<void> {
  return invoke<void>("forget_agent_session", { sessionId });
}

export function attachAgent(
  agentId: AgentSessionId,
  onEvent: (ev: AgentEvent) => void,
): Promise<AgentSession> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  return invoke<AgentSession>("attach_agent", { agentId, channel });
}

/// Show a ⌘J planner — the repo's, or the global scratch agent with
/// `workspaceId` null. Attaches to the running session (ring buffer replayed
/// into the channel) or starts one; a new repo planner first refreshes its
/// checkout to `origin/<default>`, which can take a fetch's worth of time.
/// With `resume` (a past conversation's session id), the planner's
/// running session is replaced by that conversation. `prompt` is a new
/// session's first message (ignored when attaching).
export function openPlanner(
  workspaceId: WorkspaceId | null,
  cols: number,
  rows: number,
  onEvent: (ev: AgentEvent) => void,
  resume?: string,
  prompt?: string,
): Promise<PlannerOpened> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  return invoke<PlannerOpened>("open_planner", {
    workspaceId,
    resume: resume ?? null,
    prompt: prompt ?? null,
    cols,
    rows,
    channel,
  });
}

/// Commits a repo planner's base ref (`origin/<default>`) has gained since
/// its checkout was refreshed; fetches origin first. Null before its first
/// session.
export function plannerCommitsBehind(workspaceId: WorkspaceId): Promise<number | null> {
  return invoke<number | null>("planner_commits_behind", { workspaceId });
}

/// A planner's past conversations, newest first (global = null).
export function listPlannerHistory(workspaceId: WorkspaceId | null): Promise<AgentHistoryEntry[]> {
  return invoke<AgentHistoryEntry[]>("list_planner_history", { workspaceId });
}

/// Activity of every planner with a session (global = `workspaceId` null).
export function plannerActivities(): Promise<PlannerActivity[]> {
  return invoke<PlannerActivity[]>("planner_activities");
}

export function listAgentActivity(
  workspaceId: WorkspaceId,
): Promise<WorktreeActivity[]> {
  return invoke<WorktreeActivity[]>("list_agent_activity", { workspaceId });
}

export function listAgentOverview(
  workspaceIds: WorkspaceId[],
): Promise<AgentOverview[]> {
  return invoke<AgentOverview[]>("list_agent_overview", { workspaceIds });
}

/// Answer the permission dialog a Claude agent is blocked on: Enter for
/// allow, Esc for deny. Rejects if the prompt is no longer pending.
export function agentRespondPermission(
  agentId: AgentSessionId,
  allow: boolean,
): Promise<void> {
  return invoke<void>("agent_respond_permission", { agentId, allow });
}

/// Submit `text` as the agent's next prompt: a bracketed paste + Enter into a
/// PTY agent, `session/prompt` for an ACP agent.
export function agentSubmitPrompt(agentId: AgentSessionId, text: string): Promise<void> {
  return invoke<void>("agent_submit_prompt", { agentId, text });
}

/// Cancel an ACP agent's running turn.
export function acpCancel(agentId: AgentSessionId): Promise<void> {
  return invoke<void>("acp_cancel", { agentId });
}

/// Switch an ACP agent's permission mode; the change streams back as a
/// `modes` event.
export function acpSetMode(agentId: AgentSessionId, modeId: string): Promise<void> {
  return invoke<void>("acp_set_mode", { agentId, modeId });
}

/// Answer an ACP permission request with one of its option ids.
export function acpRespondPermission(
  agentId: AgentSessionId,
  requestId: string,
  optionId: string,
): Promise<void> {
  return invoke<void>("acp_respond_permission", { agentId, requestId, optionId });
}

/// What an ACP launch runs per backend: a treehouse.toml `[agent.acp]`
/// override, the managed pinned adapter, or the CLI's native ACP mode.
export function getAcpAdapters(): Promise<AcpAdapterInfo[]> {
  return invoke<AcpAdapterInfo[]>("acp_adapters_get");
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

/// Sweep the Rust LSP registry by worktree, killing every server
/// attached to it regardless of language. Used by "Restart language
/// servers"; bypasses the JS-tracked serverId set so a desync can't
/// leave a still-alive server that the next ensureSession attaches
/// to.
export function lspKillForWorktree(worktreeId: WorktreeId): Promise<void> {
  return invoke<void>("lsp_kill_for_worktree", { worktreeId });
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

export function lspResolveCommand(command: string): Promise<string | null> {
  return invoke<string | null>("lsp_resolve_command", { command });
}

/// Insert or replace a language's `[[lsp.language]]` entry in
/// `treehouse.toml` (matched by `config.id`), forking a built-in if
/// needed. Running servers for that language are killed so they
/// respawn with the new config. Resolves to the refreshed merged
/// config list.
export function lspUpsertLanguage(config: LspConfig): Promise<LspConfig[]> {
  return invoke<LspConfig[]>("lsp_upsert_language", { config });
}

/// Drop a language's `treehouse.toml` entry — restores the built-in
/// default, or deletes a purely custom language. Resolves to the
/// refreshed merged config list.
export function lspResetLanguage(languageId: string): Promise<LspConfig[]> {
  return invoke<LspConfig[]>("lsp_reset_language", { languageId });
}

/// IDs of the code-seeded built-in languages.
export function lspBuiltinIds(): Promise<string[]> {
  return invoke<string[]>("lsp_builtin_ids");
}

/// IDs that currently have a `[[lsp.language]]` entry in
/// `treehouse.toml` (customized built-ins + custom languages).
export function lspCustomizedIds(): Promise<string[]> {
  return invoke<string[]>("lsp_customized_ids");
}

/// Per-workspace `[[lsp.override]]` entries from `treehouse.toml`.
export function lspOverridesGet(): Promise<LspOverride[]> {
  return invoke<LspOverride[]>("lsp_overrides_get");
}

/// Replace the whole `[[lsp.override]]` list. Applies on the next file
/// open / "Restart language servers" (read fresh at session spawn, not
/// mid-session). Resolves to the persisted list.
export function lspOverridesSet(
  overrides: LspOverride[],
): Promise<LspOverride[]> {
  return invoke<LspOverride[]>("lsp_overrides_set", { overrides });
}

/// Agent launch profiles visible from a repo root: its own
/// `[[agent.profile]]` entries first, then global ones.
export function listAgentProfiles(workspaceRoot: string): Promise<AgentProfile[]> {
  return invoke<AgentProfile[]>("agent_profiles_list", { workspaceRoot });
}

/// Insert or replace a launch profile in `treehouse.toml`, matched by
/// `(workspace, name)`.
export function saveAgentProfile(profile: AgentProfile): Promise<void> {
  return invoke<void>("agent_profile_save", { profile });
}

/// Remove a launch profile from `treehouse.toml`, matched by
/// `(workspace, name)`; `null` workspace targets a global profile.
export function deleteAgentProfile(workspace: string | null, name: string): Promise<void> {
  return invoke<void>("agent_profile_delete", { workspace, name });
}

/// User-level worktree lifecycle hooks (`[[worktree.on_create]]` /
/// `[[worktree.on_destroy]]`).
export function worktreeHooksGet(): Promise<WorktreeHooks> {
  return invoke<WorktreeHooks>("worktree_hooks_get");
}

/// Replace both worktree hook arrays. Read fresh on the next worktree
/// create/destroy. Resolves to the persisted lists.
export function worktreeHooksSet(
  onCreate: WorktreeHookEntry[],
  onDestroy: WorktreeHookEntry[],
): Promise<WorktreeHooks> {
  return invoke<WorktreeHooks>("worktree_hooks_set", { onCreate, onDestroy });
}

/// Effective agent status patterns (defaults filled in for uncustomized
/// backends) + the list of explicitly-customized backend keys.
export function agentPatternsGet(): Promise<AgentPatternsView> {
  return invoke<AgentPatternsView>("agent_patterns_get");
}

/// Persist one backend's status patterns. Applied live to running
/// agents (shared pattern handle; takes effect on the next PTY chunk).
export function agentPatternsSet(
  backend: AgentBackendKind,
  patterns: BackendPatterns,
): Promise<AgentPatternsView> {
  return invoke<AgentPatternsView>("agent_patterns_set", { backend, patterns });
}

/// Drop one backend's customization so its built-in defaults apply.
export function agentPatternsReset(
  backend: AgentBackendKind,
): Promise<AgentPatternsView> {
  return invoke<AgentPatternsView>("agent_patterns_reset", { backend });
}

/// Ensure `treehouse.toml` exists (seeded with a header + schema
/// comment on first call) and open it in the user's default `.toml`
/// editor. Backs the "Settings: Edit" palette entry; we don't have
/// an in-app editor for the file since editor write-back is post-MVP.
export function treehouseConfigOpenFile(): Promise<void> {
  return invoke<void>("treehouse_config_open_file");
}

/// Re-read `treehouse.toml` after the user edits it out-of-app and
/// apply the new agent-status pattern set to all running agents.
/// Reader threads share the pattern handle, so the change takes
/// effect on the next PTY chunk — no agent restart needed. LSP
/// overrides / custom languages / worktree hooks read fresh on each
/// lookup, so they don't need an explicit reload.
export function treehouseConfigReload(): Promise<void> {
  return invoke<void>("treehouse_config_reload");
}

/// Reveal `~/Library/Logs/com.treehouse.app/` in Finder. Backed by
/// the daily-rotated `treehouse.log` files written by `tracing-
/// appender` on the Rust side. Useful when something goes sideways
/// in the released DMG (devtools off, stderr launchd-eaten).
export function openLogsFolder(): Promise<void> {
  return invoke<void>("open_logs_folder");
}

/// Read an app-managed system file for the in-app viewer. `kind` is
/// one of `"log"` / `"treehouseConfig"`. For `"log"`, optional `file`
/// picks a specific daily-rotated file (default = newest).
export type AppFileKind = "log" | "treehouseConfig";

export function readAppTextFile(
  kind: AppFileKind,
  file?: string,
): Promise<AppFileContent> {
  return invoke<AppFileContent>("read_app_text_file", { kind, file });
}

/// Save an app-managed system file from the in-app viewer. Only the
/// config kind is writable on the Rust side — logs are owned by
/// tracing-appender and writing them in-app would race with the next
/// emit. Throws for `"log"`.
export function writeAppTextFile(
  kind: AppFileKind,
  content: string,
): Promise<void> {
  return invoke<void>("write_app_text_file", { kind, content });
}

export function listLogFiles(): Promise<string[]> {
  return invoke<string[]>("list_log_files");
}

/// Returns the resolved post-create hook for the worktree's workspace.
/// Empty array = no hook. `${WORKTREE_PATH}` etc. are already
/// substituted server-side; the renderer just stitches together a
/// shell script string with literal values.
export function worktreeSetupSteps(
  worktreeId: WorktreeId,
): Promise<HookStep[]> {
  return invoke<HookStep[]>("worktree_setup_steps", { worktreeId });
}

/// Touch `<worktree>/.treehouse/setup-ran` after the post-create hook
/// completes successfully. Best-effort; failures are logged client-side
/// but don't surface to the user.
export function worktreeMarkSetupRan(
  worktreeId: WorktreeId,
): Promise<void> {
  return invoke<void>("worktree_mark_setup_ran", { worktreeId });
}

export function onLspServersChanged(
  workspaceId: WorkspaceId,
  handler: () => void,
): Promise<UnlistenFn> {
  return listen(`workspace://${workspaceId}/lsp-servers-changed`, handler);
}

// --- Forge (GitLab / GitHub via glab / gh) ---

export function forgeStatus(workspaceId: WorkspaceId): Promise<ForgeStatus> {
  return invoke<ForgeStatus>("forge_status", { workspaceId });
}

/// `filters.assignee`: a username, "@me", or "none" (unassigned).
/// `filters.labels`: every one must match.
export function forgeListIssues(
  workspaceId: WorkspaceId,
  query: string,
  stateFilter: "open" | "closed" | "all",
  limit: number,
  filters: { labels?: string[]; assignee?: string } = {},
): Promise<ForgeIssue[]> {
  return invoke<ForgeIssue[]>("forge_list_issues", {
    workspaceId,
    query,
    stateFilter,
    limit,
    labels: filters.labels ?? null,
    assignee: filters.assignee ?? null,
  });
}

export function forgeGetIssue(
  workspaceId: WorkspaceId,
  number: number,
): Promise<ForgeIssue> {
  return invoke<ForgeIssue>("forge_get_issue", { workspaceId, number });
}

export function forgeSetIssueAssignee(
  workspaceId: WorkspaceId,
  number: number,
  assign: boolean,
): Promise<void> {
  return invoke<void>("forge_set_issue_assignee", { workspaceId, number, assign });
}

export function forgeListMrs(
  workspaceId: WorkspaceId,
  stateFilter: "open" | "merged" | "closed" | "all",
  limit: number,
): Promise<ForgeMr[]> {
  return invoke<ForgeMr[]>("forge_list_mrs", { workspaceId, stateFilter, limit });
}

export function forgeFindMrForBranch(
  workspaceId: WorkspaceId,
  branch: string,
): Promise<ForgeMr | null> {
  return invoke<ForgeMr | null>("forge_find_mr_for_branch", {
    workspaceId,
    branch,
  });
}

/// `closeIssue`: keep (or, false, remove) a linked worktree's `Closes #n`
/// line — Rust guarantees exactly one when true.
export function forgeCreateMr(
  workspaceId: WorkspaceId,
  branch: string,
  title: string,
  body: string | null,
  draft: boolean,
  closeIssue: boolean,
): Promise<ForgeMr> {
  return invoke<ForgeMr>("forge_create_mr", {
    workspaceId,
    branch,
    title,
    body,
    draft,
    closeIssue,
  });
}

/// The issue as an agent prompt (same text create-from-issue seeds).
export function forgeIssuePrompt(workspaceId: WorkspaceId, number: number): Promise<string> {
  return invoke<string>("forge_issue_prompt", { workspaceId, number });
}

export function forgeCreateIssue(
  workspaceId: WorkspaceId,
  title: string,
  body: string,
): Promise<ForgeIssue> {
  return invoke<ForgeIssue>("forge_create_issue", { workspaceId, title, body });
}

/// Fails with kind `Conflict` when the issue's `updatedAt` no longer matches
/// `expectedUpdatedAt` (edited on the forge meanwhile); pass null to skip the
/// check (overwrite).
export function forgeUpdateIssue(
  workspaceId: WorkspaceId,
  number: number,
  title: string,
  body: string,
  expectedUpdatedAt: string | null,
): Promise<ForgeIssue> {
  return invoke<ForgeIssue>("forge_update_issue", {
    workspaceId,
    number,
    title,
    body,
    expectedUpdatedAt,
  });
}

/// The worktree → issue link map changed (UI or an agent over MCP).
export function onIssueLinksChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("issue-links://changed", handler);
}

/// An MR/PR was created for `branch` in this workspace (UI or MCP).
export function onMrChanged(
  workspaceId: WorkspaceId,
  handler: (branch: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`workspace://${workspaceId}/mr-changed`, (e) => handler(e.payload));
}

/// CI for `branch` in this workspace changed outside the CI tab (an agent
/// retried a job over MCP).
export function onCiChanged(
  workspaceId: WorkspaceId,
  handler: (branch: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`workspace://${workspaceId}/ci-changed`, (e) => handler(e.payload));
}

/// An agent created or edited an issue over MCP. Payload: the issue number.
export function onIssuesChanged(
  workspaceId: WorkspaceId,
  handler: (number: number) => void,
): Promise<UnlistenFn> {
  return listen<number>(`workspace://${workspaceId}/issues-changed`, (e) => handler(e.payload));
}

export function forgeApproveMr(
  workspaceId: WorkspaceId,
  iid: number,
): Promise<void> {
  return invoke<void>("forge_approve_mr", { workspaceId, iid });
}

export function forgeUnapproveMr(
  workspaceId: WorkspaceId,
  iid: number,
): Promise<void> {
  return invoke<void>("forge_unapprove_mr", { workspaceId, iid });
}

export function forgeMrApproval(
  workspaceId: WorkspaceId,
  iid: number,
): Promise<ForgeApproval> {
  return invoke<ForgeApproval>("forge_mr_approval", { workspaceId, iid });
}

export function forgeMergeMr(
  workspaceId: WorkspaceId,
  iid: number,
): Promise<void> {
  return invoke<void>("forge_merge_mr", { workspaceId, iid });
}

export function forgePostMrComment(
  workspaceId: WorkspaceId,
  iid: number,
  body: string,
): Promise<void> {
  return invoke<void>("forge_post_mr_comment", { workspaceId, iid, body });
}

export function forgePostReviewComments(
  workspaceId: WorkspaceId,
  iid: number,
  comments: ReviewCommentInput[],
): Promise<void> {
  return invoke<void>("forge_post_review_comments", {
    workspaceId,
    iid,
    comments,
  });
}

export function forgeListThreads(
  workspaceId: WorkspaceId,
  iid: number,
): Promise<ForgeThread[]> {
  return invoke<ForgeThread[]>("forge_list_threads", { workspaceId, iid });
}

export function forgeReplyThread(
  workspaceId: WorkspaceId,
  iid: number,
  discussionId: string,
  body: string,
): Promise<void> {
  return invoke<void>("forge_reply_thread", {
    workspaceId,
    iid,
    discussionId,
    body,
  });
}

export function forgeResolveThread(
  workspaceId: WorkspaceId,
  iid: number,
  discussionId: string,
  resolved: boolean,
): Promise<void> {
  return invoke<void>("forge_resolve_thread", {
    workspaceId,
    iid,
    discussionId,
    resolved,
  });
}

export function forgeListPipelines(
  workspaceId: WorkspaceId,
  branch: string,
): Promise<ForgePipeline[]> {
  return invoke<ForgePipeline[]>("forge_list_pipelines", { workspaceId, branch });
}

export function forgePipelineJobs(
  workspaceId: WorkspaceId,
  pipelineId: number,
): Promise<ForgeJob[]> {
  return invoke<ForgeJob[]>("forge_pipeline_jobs", { workspaceId, pipelineId });
}

export function forgeRetryPipeline(
  workspaceId: WorkspaceId,
  pipelineId: number,
): Promise<void> {
  return invoke<void>("forge_retry_pipeline", { workspaceId, pipelineId });
}

export function forgeRetryJob(
  workspaceId: WorkspaceId,
  jobId: number,
): Promise<void> {
  return invoke<void>("forge_retry_job", { workspaceId, jobId });
}

export function forgeJobLog(
  workspaceId: WorkspaceId,
  jobId: number,
): Promise<ForgeJobLog> {
  return invoke<ForgeJobLog>("forge_job_log", { workspaceId, jobId });
}
