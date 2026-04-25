# treehouse

A desktop **agentic development environment (ADE)** for working alongside AI coding agents. Open a repo, spin up isolated git worktrees, launch Claude Code / Codex / Kiro inside each, review their work in a live diff, send inline comments back as prompts, and merge the result with the strategy of your choice.

> Greenfield, macOS-first, early stage.

## Why an ADE, not an IDE

Conventional IDEs treat AI agents as a side panel bolted onto a traditional editor. treehouse flips that: the **worktree is the unit of work**, the **diff is the primary review surface**, and the editor exists in service of reviewing what the agent wrote — not for hand-typing implementations. Three agents on three branches in parallel is the default mode, not the exotic case.

## What's in it

### Worktrees and agents

- **Worktree sidebar** with pinned main-clone entry, per-worktree activity glyph (spinner / check / amber-triangle), ↑ahead/↓behind commit counts, dirty / merged decorations.
- **Per-worktree tabbed agents.** Multiple sessions per worktree (Claude + Codex side-by-side, two Claudes, etc). Each tab gets a name like `Claude 1` or `Claude 2 (code-reviewer)`. Agents survive worktree switches via a ring-buffer reattach.
- **Sub-agent picker.** When launching Claude or Kiro, a second dropdown lists discovered profiles (`claude agents list` / `kiro-cli agent list`) so you can start a session pre-bound to one — pass-through becomes `claude --agent <name>` or `kiro-cli chat --agent <name>`.
- **Shift+Enter inserts a newline** in agent panes (alt+enter sequence) so multi-line prompts compose normally instead of submitting on the first line.

### Diff and review

- **Live multi-file diff.** File-watcher feeds a debounced git2 recompute; agent output lights the diff up within ~300ms of the file landing on disk.
- **Changes list + file tree.** The Changes list shows just what moved (filename tinted by git status — modified amber, added emerald, deleted rose strikethrough, renamed blue, untracked muted emerald). The file tree shows the whole worktree with per-language brand icons (TypeScript, Python, Rust, Go, …) and indent guides.
- **Inline review comments** in either view. Click the `+` in the gutter of the **File** tab or the **Diff** tab to anchor a comment to a line. Per-comment Send routes to the active agent by default; the `▾` next to it opens a picker so you can route to any running agent in that worktree without affecting subsequent sends.
- **Send queue.** Queue several comments and batch-send to a chosen target as a single prompt. The dropdown lets you jump back to any commented line, unqueue, or preview the formatted prompt before sending.

### Editor surface

- **Monaco editor** for File and Diff views, theme matched across the rest of the app's chrome.
- **Shiki TextMate syntax highlighting** for languages where Monaco's built-in Monarch grammars are weak (Rust, Python, Go, TOML, YAML, Dockerfile, shell, …) — same engine VS Code uses, with the Dark+ palette layered on the Dark Modern 2026 chrome. TS/JS/TSX/JSX intentionally stay on Monaco's tokenizer.
- **Markdown preview tab.** Open any `.md` file and flip to Preview for GFM-rendered output that live-refreshes as the agent rewrites the file.
- **Opt-in language servers.** Toggle Rust, TypeScript/JS, Python, Go, C/C++, Ruby, or Lua in Settings → Languages. Each enabled language spawns a per-worktree stdio server (`rust-analyzer`, `pyright-langserver`, `typescript-language-server`, `gopls`, `clangd`, …) wired into Monaco for hover, ⌘-click goto-definition (same-file + cross-file within the worktree), completions, signature help, and diagnostics. Custom servers plug in by appending to `~/Library/Application Support/com.treehouse.app/languages.toml`.

### Terminals

- **Per-worktree tabbed terminals**, each with **tmux-style binary split panes**: split-right `⇥`, split-below `⤓`, click any pane to make it active, hover to reveal a per-pane close. Drag the dividers to resize. Layouts persist across worktree switches — leave a 4-pane setup in worktree A, navigate to B, come back, the same panes (and the same shell sessions, with their scrollback) are still there.

### Workflow

- **Merge-back dialog** with three strategies: merge commit, squash + commit, rebase + ff. Defaults persist; per-action override via the `▾`.
- **Sync ↓** pulls the default branch into a worktree via merge or rebase. Auto-aborts the rebase on conflict.
- **Focus mode (`⌘\`)** hides the terminal + agent panes for distraction-free code reading.

## Install

Grab the latest `.dmg` from [Releases](https://github.com/kylewalters18/treehouse/releases), drag `treehouse.app` to `/Applications`, then clear the quarantine bit once:

```sh
xattr -dr com.apple.quarantine /Applications/treehouse.app
```

(The `.dmg` is ad-hoc signed, not notarized — without that `xattr` step macOS refuses to launch it. Paying Apple's $99/yr to skip this isn't worth it for a pre-v1 tool.)

Apple Silicon only for now.

## Build from source

Requirements: macOS, Rust 1.77+, Node 20+, git.

```sh
npm install
npm run tauri dev         # hot-reload dev build
npm run tauri build       # produces .app + .dmg under src-tauri/target/release/bundle/
```

First build compiles ~450 Rust crates (~2 minutes). Subsequent rebuilds are a few seconds. The window pops up; click **Open repository** and pick any local git repo.

## How a session usually goes

1. Pick a repo from **Home** (recent repos are remembered).
2. *(Optional, one-time per machine)* open ⚙ → **Languages** and toggle the languages you care about. Requires the corresponding server binary on `PATH` — the row shows `found at …` or the install hint.
3. In the sidebar, type a name + click `+` → creates a worktree at `<repo>__worktrees/<slug>/` on a new branch `<slug>`.
4. Select the worktree → the right pane shows an **Agent** tab. Pick a backend, optionally pick a sub-agent profile, click **+ Launch**.
5. As the agent writes files, the **Diff** pane updates live. Click a file in the Changes list to see hunks; switch to the **File** tab for full content — hover / goto / completions come through the language server for enabled languages.
6. Drop inline review comments by clicking `+` in either the File or Diff gutter. Use `▾` next to **Send** if you want a specific agent (otherwise the active tab gets it). Or queue several and batch-send.
7. Use the embedded **Terminal** to run tests or inspect state — split as needed, layout sticks.
8. When happy, click **Merge** → the dialog previews the strategy, runs `git merge --no-ff` / `--squash` / rebase+ff on the main repo.
9. Or click **Sync ↓** first to pull the default branch into the worktree.

## Architecture (tl;dr)

- **Tauri v2.** Rust backend owns all the state that needs concurrency correctness (git, subprocess handles, file contents, diff cache, watchers, PTY handles); React 19 renderer is a view layer fed by `#[tauri::command]` calls and `Channel<T>` server-push streams.
- **git2-rs** for diff computation, shell-out to `git` for everything else (worktree ops, merges, rebases) — that way user git config, hooks, and credential helpers all just work.
- **portable-pty** for terminals and TTY-requiring agents.
- **Per-tab pane tree.** Terminal splits are a binary tree of `{ leaf | split }` nodes; xterm `Terminal` instances live in a worktree-keyed pool above the React subtree so split / sibling-close / worktree-switch reshapes the layout without reattaching PTYs (which would have zsh redraw with PROMPT_SP — the `%` artefact).
- **ts-rs** generates TypeScript types from the Rust structs. Run `npm run gen-types` after changing any `#[derive(TS)]` type.

For deeper detail — module layout, IPC conventions, gotchas — see [`CLAUDE.md`](./CLAUDE.md).

## Status & scope

v0 MVP is shipped; it's useful for one person on one machine.

- **Platform**: macOS only. Linux/Windows untested.
- **Packaging**: ad-hoc signed `.dmg` produced by `npm run tauri build`. Unnotarized — users need a one-time `xattr -dr com.apple.quarantine` after install.

## Conventions worth knowing

- Worktrees live **as a sibling directory** at `<repo>__worktrees/<slug>/`, not inside the repo. Keeps `.gitignore` clean; the `__worktrees` suffix is visible in Finder.
- **No auto-committing, ever.** When the merge flow would be a no-op, it tells you to commit first. Squash merge asks for your commit message. Sync refuses if the workdir is dirty.
- **Agents don't run in the main clone.** The main repo shows up as a pinned sidebar entry with read-only tools (terminal + diff + tree); the agent pane is omitted entirely when it's selected.
- **ts-rs bindings are checked into the repo** (`src/ipc/bindings/`) so fresh clones build without a separate generation step. Regenerate with `npm run gen-types`.
- **Per-comment Send routes to the active tab** by default. Picking a different target via `▾` is a one-shot — no sticky preference — so you can fire one comment at a side agent without changing the default.
