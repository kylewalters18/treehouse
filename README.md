# treehouse

A desktop IDE built around **parallel AI-agent development in git worktrees**. Open a repo, spin up isolated worktrees, launch Claude Code / Codex / Kiro inside each, and review their work side-by-side through a live-updating multi-file diff.

> Greenfield, macOS-first, early stage.

## Why

Conventional IDEs treat AI agents as a side panel bolted onto a traditional editor. treehouse flips that: the **worktree is the unit of work** and the **diff is the primary review surface**. You can have three agents, on three branches, running in parallel — and merge their output back with merge, squash, or rebase strategies.

## What's in it

- **Worktree sidebar** with pinned main-clone entry, activity dots, ↑ahead/↓behind commit counts
- **Diff pane** with a Changes list (just what moved) and a Files tree (whole worktree), file-level A/M/D badges, click-through to a syntax-highlighted Monaco viewer
- **Live diff updates** — file-watcher feeds a debounced git2 diff recompute; agent output lights the pane up within ~300ms
- **Tabbed terminals and agents** per worktree. Multiple shells and multiple agent sessions (Claude + Codex side-by-side, two Claudes, whatever). Agents survive worktree switches via a ring-buffer reattach
- **Inline review comments**. Click the `+` in the gutter to anchor a comment to a line, queue several, and send them to the active agent as a single prompt
- **Opt-in language servers (LSP)**. Toggle Rust, TypeScript/JS, Python, Go, C/C++, Ruby, or Lua in Settings → Languages. Each enabled language spawns a per-worktree stdio server (`rust-analyzer`, `pyright-langserver`, `typescript-language-server`, `gopls`, `clangd`, …) wired into Monaco for hover docs, ⌘-click goto-definition (including cross-file jumps within the worktree), completions, signature help, and diagnostic squigglies. Custom servers plug in by appending to `~/Library/Application Support/com.treehouse.app/languages.toml`
- **Merge-back dialog** with three strategies: merge commit, squash + commit, or rebase + ff. Defaults persist; per-action override via the ▾
- **Sync ↓** pulls the default branch into a worktree via merge or rebase (configurable). Auto-aborts rebase on conflict
- **Focus mode** (`⌘\`) hides terminal + agent panes for distraction-free code reading

## Run it

Requirements: macOS, Rust 1.77+, Node 20+, git.

```sh
npm install
npm run tauri dev
```

First build compiles ~450 Rust crates (~2 minutes). Subsequent rebuilds are a few seconds. The window should pop up; click **Open repository** and pick any local git repo.

## How a session usually goes

1. Pick a repo from **Home** (recent repos are remembered).
2. (Optional, one-time per machine) open ⚙ → **Languages** and toggle the languages you care about. Requires the corresponding server binary on `PATH` — the row shows `found at …` or the install hint.
3. In the sidebar, type a name in the input + click `+` → creates a worktree at `<repo>__worktrees/<slug>/` on branch `agent/<slug>`.
4. Select the worktree → the right pane shows an **Agent** tab. Pick a backend, click **Launch**.
5. As the agent writes files, the **Diff** pane updates live. Click a file in the Changes list to see hunks; switch to the **File** tab for full content — hover / goto / completions come through the language server for enabled languages.
6. Drop inline review comments by clicking `+` in the gutter, queue them up, then batch-send to the active agent.
7. Use the embedded **Terminal** to run tests or inspect state.
8. When happy, click **Merge** → the dialog previews the strategy, runs `git merge --no-ff` or `--squash` or rebase+ff on the main repo.
9. Or click **Sync ↓** first to pull the default branch into the worktree.

## Architecture (tl;dr)

- **Tauri v2**: Rust backend owns all state, React 19 renderer is a view layer fed by commands + Channels.
- **git2-rs** for diff computation, shell-out to `git` for everything else (worktree ops, merges, rebases) — that way user git config, hooks, and credential helpers all just work.
- **portable-pty** for terminals and (TTY-requiring) agents.
- **ts-rs** generates TypeScript types from the Rust structs. Run `npm run gen-types` after changing any `#[derive(TS)]` type.

For deeper detail — module layout, IPC conventions, gotchas — see [`CLAUDE.md`](./CLAUDE.md).

## Status & scope

v0 MVP is shipped; it's useful for one person on one machine. Meaningful gaps:

- **Platform**: macOS only. Linux/Windows untested.
- **Tests**: 73 Rust (`cargo test`) covering git operations, worktree reconciliation, diff compute, LSP root-marker resolution; 59 frontend (`npm test`, Vitest) covering the Zustand stores and pure utilities. No integration / E2E coverage yet.
- **Packaging**: no `.dmg` yet; run via `npm run tauri dev`.
- **Not implemented**: hunk-level accept/reject, cross-worktree search, command palette, editor write-back, notifications when agents need attention, settings UI beyond the gear menu.
- **LSP gaps**: no indexing-progress indicator (rust-analyzer/pyright can feel silent for 10–60s on first open), no semantic tokens / inlay hints / code-action lightbulb, no `workspace/configuration` response (servers run with defaults), no goto into external stdlib paths (same-file + in-worktree jumps only).

## Conventions worth knowing

- Worktrees live **as a sibling directory** at `<repo>__worktrees/<slug>/`, not inside the repo. Keeps `.gitignore` clean; the `__worktrees` suffix is visible in Finder.
- **No auto-committing, ever.** When the merge flow would be a no-op, it tells you to commit first. Squash merge asks for your commit message. Sync refuses if the workdir is dirty.
- **Agents don't run in the main clone.** The main repo shows up as a pinned sidebar entry with read-only tools (terminal + diff + tree); the agent pane is omitted entirely when it's selected.
- **ts-rs bindings are checked into the repo** (`src/ipc/bindings/`) so fresh clones build without a separate generation step. Regenerate with `npm run gen-types`.
