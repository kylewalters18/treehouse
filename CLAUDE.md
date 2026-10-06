# treehouse

macOS desktop app for running AI coding agents (Claude Code / Codex / Kiro) in parallel git worktrees. Each worktree has tabbed agents and terminals (PTY subprocesses), a Monaco editor with opt-in LSPs, and a live diff against a base ref. Inline review comments are queued and batch-sent to an agent as a prompt; merge-back supports merge / squash / rebase.

Tauri v2 (Rust backend) + React 19 + Vite. macOS only.

**Design constraints.** The layout is one self-contained session per worktree (editor, agents, shell), with the diff as the main review surface — prefer changes that serve that loop. The editor is Monaco with Shiki grammars, but this is not a VS Code extension or Code-OSS fork: there is no workbench or extension host, so editor-adjacent features (LSP wiring, highlighting) are implemented here.

## Stack at a glance

| Concern | Pick | Why |
|---|---|---|
| Shell | Tauri v2 | Small binary, native perf for git/PTY/FS; React for UI |
| Git mutation | shell out to `git` | User's config, hooks, credential helpers just work |
| Git diff (read) | `git2-rs` | Fast, in-process, no fork per fs event |
| File watch | `notify-debouncer-full` 0.3 + `ignore` | Debounced, gitignore-aware |
| PTY (agents + terminals) | `portable-pty` | Claude Code needs a TTY |
| Type sharing | `ts-rs` 10 | Derives generate TS from Rust structs |
| State (JS) | Zustand 5 | Lightweight; stores mirror Rust-owned state |
| Styling | Tailwind 3 + shadcn-style | Minimal component libs; Tailwind handles layout |
| Layout | `react-resizable-panels` | Drag-to-resize 3+ region splits |

## Architecture

**The Rust side is the source of truth.** The renderer is a view layer that caches snapshots fed by Tauri events + Channels. Anything requiring concurrency correctness (git state, subprocess handles, file contents on disk, diff cache, watchers, PTY handles) lives in `AppState` on the Rust side. React owns only UI-local state (selected worktree, open tabs, transcript scroll position).

**Two IPC channels, sharp distinction:**

- `#[tauri::command]` = imperative request/response. Examples: `open_workspace`, `create_worktree`, `launch_agent`, `get_diff`.
- `tauri::ipc::Channel<T>` = server-push streams returned **from** a command. Used for anything high-volume or evented: PTY output, agent output, fs/diff updates. Channel handles are returned from the launch command itself to eliminate the "first N bytes lost before listener attaches" class of bug.

Global `tauri::Emitter` events (`app.emit(...)`) are used sparingly for fan-out signals like `workspace://{id}/worktrees-changed` — anything per-session goes over a dedicated Channel.

**Worktree path convention.** For a repo at `/path/to/myrepo`, worktrees live **as a sibling**: `/path/to/myrepo__worktrees/<slug>` on branch `<slug>`. Never inside the repo (no `.gitignore` pollution) and never user-global (easier to discover in Finder). The `__worktrees` suffix is a hard-coded convention; see `worktree::git_ops::worktrees_root_for`. Worktrees created before the prefix was dropped may carry an `agent/<slug>` branch — reconcile adopts them without rewriting.

## Module map

```
src-tauri/src/
  main.rs, lib.rs         # Tauri builder, command/channel registration, shutdown hook
  state.rs                # AppState: DashMap registries + async merge lock
  storage.rs              # Persisted JSON under ~/Library/Application Support/com.treehouse.app/
                          #   recent workspaces, comments, pins, worktree→issue links, settings
  user_config.rs          # User-edited treehouse.toml: custom LSPs, LSP overrides, worktree hooks,
                          #   agent status patterns
  scratch.rs              # Global ⌘J scratch agent, not tied to a repo
  planner.rs              # Per-repo ⌘J planner: read-only `clone --shared` of origin/<default> at
                          #   <repo>__worktrees/.planner (not a git worktree → never adopted), refreshed
                          #   per session; MCP-scoped to its repo
  fs_api.rs               # File tree + read-file commands (ignore-aware)
  test_support.rs         # Shared fixtures (repo scaffolding, etc.) for #[cfg(test)]
  ipc/
    commands.rs           # All #[tauri::command] fns — thin wrappers over modules
    events.rs             # Typed event name helpers
    mod.rs
  workspace/              # Workspace type, repo discovery, default branch detection
  worktree/               # Worktree type, git_ops (shell-out), manager (CRUD + merge + sync)
  agent/                  # AgentSession, supervisor (PTY-based; tabbed — many sessions per worktree),
                          #   hooks.rs wires Claude Code status hooks → WorktreeActivity
  pty/                    # TerminalSession, manager (portable-pty; tabbed — many per worktree)
  lsp/                    # Per-worktree language servers, stdio transport, root detection,
                          #   registry + supervisor; opt-in via settings, Monaco-facing events
  diff/                   # DiffSet types + compute (git2 diff_tree_to_workdir)
  fs_watch/               # Per-worktree debounced notify watcher → triggers diff recompute
  forge/                  # GitLab (REST + ~/.netrc) / GitHub (gh) issues, MR/PR threads, CI;
                          #   workflow.rs = issue → worktree → PR steps shared by UI commands + MCP
  mcp/                    # Local MCP server exposed to launched Claude / Kiro sessions
                          #   (create_worktree [+issue], create_issue, create_pr, list_repos)
  util/
    ids.rs                # ULID-backed typed ID newtypes (WorktreeId, AgentSessionId, LspServerId, ...)
    errors.rs             # AppError → serde { kind, message }

src/
  main.tsx, App.tsx
  routes/                 Home.tsx, Workspace.tsx
  panels/                 WorktreeSidebar, DiffPane, TerminalPane, AgentPane,
                          EditorPane, FileTree, MarkdownPreview
  stores/                 workspace, worktrees, diffs, ui, toasts, comments, lsp, settings (Zustand)
  lsp/                    # Browser-side LSP client: session, manager, transport, Monaco converters
  ipc/
    client.ts             # Typed invoke()/listen()/Channel wrappers
    types.ts              # Re-exports from ./bindings/
    bindings/             # ts-rs OUTPUT — commit these; regen with `npm run gen-types`
  components/             Toaster, SettingsMenu, StatusBar, AgentBoard, …
  lib/                    cn.ts (clsx + tailwind-merge), errors.ts, agent.ts
  test/                   setup.ts, e2e-bootstrap.ts (stubs Tauri IPC for Playwright)

e2e/                      Playwright specs (smoke, workspace) against a Tauri-IPC stub
```

## Running

```sh
npm install               # once
npm run tauri dev         # full stack: Vite + cargo + webview window
```

On first run the Rust side compiles ~450 crates — give it a few minutes. Subsequent iterations are ~3s for Rust changes, instant HMR for frontend.

```sh
npm run gen-types         # after changing any Rust #[derive(TS)] type
npx tsc -b                # TypeScript project-reference build (use this, not `tsc --noEmit`)
cd src-tauri && cargo test --quiet   # Rust tests
npm test                  # Vitest (Zustand stores + pure utils)
npx playwright test       # Playwright e2e against the Tauri-IPC stub
```

The tauri-dev log is the place to look for runtime signals. Default log level is `treehouse_lib=debug`. Tracing messages like `watching worktree`, `launched agent`, `emitted diff_updated`, `lsp server ready` are informative breadcrumbs for troubleshooting.

## Conventions and gotchas

- **`npm run gen-types` is manual.** ts-rs only writes bindings when `cargo test` runs; the npm script shells to `cargo test --quiet && cp bindings ../src/ipc/bindings`. Rerun after any Rust type change — drift shows up as TypeScript errors.
- **ts-rs + serde internal tags.** `#[serde(tag = "kind", rename_all = "camelCase")]` on an enum renames the **variants**, not the **fields** inside variants. For struct-variant fields, use explicit `#[serde(rename = "camelCase")]` or pay attention — see `MergeResult::NothingToMerge`.
- **`Channel<T>` generic types.** When you send `Vec<u8>`, Tauri serializes it as a JSON number array. Fine for low-volume; consider base64 if a hotspot. PTY and agent streams both do this — see `PtyEvent` / `AgentEvent`.
- **`git2::diff_tree_to_workdir_with_index` does not honor `include_untracked`.** Use `diff_tree_to_workdir` for agent flows where files are created but not `git add`ed. This was a live-diff debugging dead-end — see `diff::compute::compute`.
- **Never auto-commit.** Merge-back detects `commits_ahead == 0` and returns `NothingToMerge { uncommittedChanges }`, surfacing state to the user. Do not silently `git add -A && git commit` on the user's behalf.
- **Agent reattach uses a ring buffer.** Supervisor keeps a bounded byte buffer per session; on pane remount the `attach_agent` command replays the buffer into a fresh Channel before live output resumes. Don't bypass this by wiring new UI directly to `launch_agent` — go through the attach path or reconnects will silently drop output.
- **Graceful shutdown hook.** `on_window_event(CloseRequested)` calls `agents.kill_all()` + `terminals.kill_all()` + `lsp.kill_all()`. New long-lived subprocess registries should plug in here to avoid orphans.
- **Startup reconciliation.** `open_workspace` runs `worktree::reconcile`: `git worktree prune`, then any path under `<repo>__worktrees/` in `git worktree list --porcelain` that we don't know about gets adopted into state with a fresh `WorktreeId`. IDs are not stable across app restarts — frontend should not persist them.
- **LSP is opt-in, per language, per worktree.** Settings toggles a language on; on first file open in an enabled language the supervisor spawns the configured binary (`rust-analyzer`, `pyright-langserver`, …) rooted at the nearest project marker (`Cargo.toml`, `package.json`, …). Custom servers and per-workspace overrides go in `~/Library/Application Support/com.treehouse.app/treehouse.toml` (see `user_config.rs`) — don't hardcode them.
- **Playwright e2e stubs Tauri IPC.** Specs run against the Vite dev server with `src/test/e2e-bootstrap.ts` shimming `window.__TAURI_INTERNALS__`; they don't exercise real Rust. Treat them as UI regression, not integration.
- **Shell PATH is imported at startup.** macOS `.app` bundles launched from Finder/launchd inherit a minimal `/usr/bin:/bin:…` PATH — `.zshrc` never runs, so brew / `~/.local/bin` / language-manager shims are invisible. `lib.rs::import_shell_path` shells out to `$SHELL -ilc 'printf %s "$PATH"'` at boot and exports the captured PATH before the Tauri builder starts. All downstream `CommandBuilder` spawns (agents, LSP, terminals) inherit it. Best-effort: on failure we leave PATH alone, never fatal.

## Scope

- macOS only; Linux / Windows are not supported.
- Codex and Kiro backends work but are less tested than Claude Code.
- No sandboxing of agent processes.
- LSP gaps: no indexing-progress UI, semantic tokens, inlay hints, `workspace/configuration`, or goto into external stdlib paths.
