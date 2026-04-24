# treehouse

Desktop IDE centered on **parallel AI-agent development in git worktrees**. The unit of work is a worktree; agents (Claude Code by default) run as long-lived subprocesses inside each worktree, and the primary review surface is a live-updating diff of that worktree against a base ref. An embedded `xterm.js` terminal sits alongside, and merge-back into the main repo is one click.

Greenfield, built macOS-first. Tauri v2 (Rust backend) + React 19 + Vite.

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

**Worktree path convention.** For a repo at `/path/to/myrepo`, worktrees live **as a sibling**: `/path/to/myrepo__worktrees/<slug>` on branch `agent/<slug>`. Never inside the repo (no `.gitignore` pollution) and never user-global (easier to discover in Finder). The `__worktrees` suffix is a hard-coded convention; see `worktree::git_ops::worktrees_root_for`.

## Module map

```
src-tauri/src/
  main.rs, lib.rs         # Tauri builder, command/channel registration, shutdown hook
  state.rs                # AppState: DashMap registries + async merge lock
  ipc/
    commands.rs           # All #[tauri::command] fns — thin wrappers over modules
    events.rs             # Typed event name helpers
    mod.rs
  workspace/              # Workspace type, repo discovery, default branch detection
  worktree/               # Worktree type, git_ops (shell-out), manager (CRUD + merge)
  agent/                  # AgentSession, supervisor (PTY-based, one agent per worktree)
  pty/                    # TerminalSession, manager (portable-pty for user shells)
  diff/                   # DiffSet types + compute (git2 diff_tree_to_workdir)
  fs_watch/               # Per-worktree debounced notify watcher → triggers diff recompute
  util/
    ids.rs                # ULID-backed typed ID newtypes (WorktreeId, AgentSessionId, ...)
    errors.rs             # AppError → serde { kind, message }

src/
  main.tsx, App.tsx
  routes/                 Home.tsx, Workspace.tsx
  panels/                 WorktreeSidebar, DiffPane, TerminalPane, AgentPane
  stores/                 workspace, worktrees, diffs, ui, toasts (Zustand)
  ipc/
    client.ts             # Typed invoke()/listen()/Channel wrappers
    types.ts              # Re-exports from ./bindings/
    bindings/             # ts-rs OUTPUT — commit these; regen with `npm run gen-types`
  components/             Toaster
  lib/cn.ts               # clsx + tailwind-merge
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
```

The tauri-dev log is the place to look for runtime signals. Default log level is `treehouse_lib=debug`. Tracing messages like `watching worktree`, `launched agent`, `emitted diff_updated` are informative breadcrumbs for troubleshooting.

## Conventions and gotchas

- **`npm run gen-types` is manual.** ts-rs only writes bindings when `cargo test` runs; the npm script shells to `cargo test --quiet && cp bindings ../src/ipc/bindings`. Rerun after any Rust type change — drift shows up as TypeScript errors.
- **ts-rs + serde internal tags.** `#[serde(tag = "kind", rename_all = "camelCase")]` on an enum renames the **variants**, not the **fields** inside variants. For struct-variant fields, use explicit `#[serde(rename = "camelCase")]` or pay attention — see `MergeResult::NothingToMerge`.
- **`Channel<T>` generic types.** When you send `Vec<u8>`, Tauri serializes it as a JSON number array. Fine for low-volume; consider base64 if a hotspot. PTY and agent streams both do this — see `PtyEvent` / `AgentEvent`.
- **`git2::diff_tree_to_workdir_with_index` does not honor `include_untracked`.** Use `diff_tree_to_workdir` for agent flows where files are created but not `git add`ed. This was a live-diff debugging dead-end — see `diff::compute::compute`.
- **Never auto-commit.** Merge-back detects `commits_ahead == 0` and returns `NothingToMerge { uncommittedChanges }`, surfacing state to the user. Do not silently `git add -A && git commit` on the user's behalf.
- **Agent reattach across pane unmount is lossy.** When the user selects a different worktree, the current Channel is torn down. We check `get_agent_for_worktree` on remount and warn "running but this window lost its live stream; kill and relaunch to view output." A Rust-side ring buffer + attach command would fix this (see post-MVP ideas below).
- **Graceful shutdown hook.** `on_window_event(CloseRequested)` calls `agents.kill_all()` + `terminals.kill_all()`. New long-lived subprocess registries should plug in here to avoid orphans.
- **Startup reconciliation.** `open_workspace` runs `worktree::reconcile`: `git worktree prune`, then any path under `<repo>__worktrees/` in `git worktree list --porcelain` that we don't know about gets adopted into state with a fresh `WorktreeId`. IDs are not stable across app restarts — frontend should not persist them.

## Scope — what's in vs. what's not

**In v0 MVP:**
- Open repo, multiple worktrees, per-worktree agent (Claude Code / Codex / Kiro), live diff, embedded terminal, merge-back, error toasts, graceful shutdown.
- Typed ID newtypes (`WorktreeId`, `AgentSessionId`, `TerminalId`, `WorkspaceId`) all ULID-backed.
- macOS only.

**Deferred (post-MVP):**
- Hunk-level accept/reject (diff viewer is read-only)
- Multiple terminals per worktree (one per worktree in v0)
- Editor write-back (Monaco is mounted read-only)
- Codex / Kiro backends ship but haven't been road-tested like Claude Code
- Agent reattach via ring buffer
- Linux / Windows
- Sandboxing (macOS `sandbox-exec`)
- Settings persistence beyond gitignored `~/.config/treehouse/`
- Cross-worktree search / command palette

See `/Users/kylewalters/.claude/plans/i-want-to-make-delightful-mccarthy.md` for the full design doc this codebase is built against.
