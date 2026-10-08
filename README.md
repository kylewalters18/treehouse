# treehouse

A macOS desktop app for running AI coding agents in parallel git worktrees. Each worktree gets its own agents (Claude Code, Codex, Kiro), terminals, and editor, plus a live diff against a base ref for reviewing what the agents change. Inline review comments can be sent back to an agent as prompts, and finished work is merged back with merge, squash, or rebase.

Built with Tauri v2 (Rust) and React 19. Early stage; macOS (Apple Silicon) only.

## Features

- **Worktrees.** Create, switch between, and delete worktrees from a sidebar showing activity, ahead/behind counts, and dirty/merged state. Worktrees are created at `<repo>__worktrees/<slug>/` on branch `<slug>`.
- **Agents.** Multiple tabbed agent sessions per worktree, running in a PTY. Sessions persist across worktree switches. Claude Code and Kiro sessions can be started with a named sub-agent profile.
- **Live diff.** A file watcher triggers a debounced `git2` diff recompute, so agent edits appear within a few hundred milliseconds.
- **Review comments.** Add comments from the gutter of the file or diff view, then send them to an agent individually or as a batched prompt from the Review tab.
- **Editor.** Monaco, with Shiki syntax highlighting for languages where Monaco's built-in grammars are weak, a Markdown preview, save support, and conflict handling when an agent modifies an open file.
- **Language servers (opt-in).** Rust, TypeScript/JS, Python, Go, C/C++, Ruby, and Lua, plus custom servers. Provides hover, completions, signature help, diagnostics, and go-to-definition.
- **Terminals.** Tabbed terminals per worktree with split panes; layouts and sessions persist across worktree switches.
- **Merge and sync.** Merge a worktree back with merge, squash, or rebase; sync the default branch into a worktree with merge or rebase.
- **Forge integration.** GitLab and GitHub issues, merge/pull request review threads, and CI status via the `glab` / `gh` CLIs.
- **MCP server.** Claude Code sessions launched by treehouse can create new worktrees through a local MCP server, subject to user approval.

## Install

Download the latest `.dmg` from [Releases](https://github.com/kylewalters18/treehouse/releases) and drag `treehouse.app` to `/Applications`. The build is ad-hoc signed and not notarized, so clear the quarantine attribute once before launching:

```sh
xattr -dr com.apple.quarantine /Applications/treehouse.app
```

## Build from source

Requirements: macOS, Rust 1.77+, Node 20+, git.

```sh
npm install
npm run tauri dev      # development build with hot reload
npm run tauri build    # .app and .dmg under src-tauri/target/release/bundle/
```

The first build compiles roughly 450 Rust crates and takes a few minutes.

## Usage

1. Open a repository from the home screen.
2. Optionally enable language servers under Settings → Languages. The corresponding server binary must be on your `PATH`.
3. Create a worktree from the sidebar.
4. Launch an agent in the worktree's Agent tab.
5. Review changes in the Diff pane and leave inline comments; send them to the agent from the Review tab.
6. Use **Sync** to bring in the default branch, and **Merge** to merge the worktree back.

## Configuration

- App settings: `~/Library/Application Support/com.treehouse.app/settings.json` (managed by the UI).
- User configuration: `~/Library/Application Support/com.treehouse.app/treehouse.toml` — custom language servers, per-workspace LSP overrides, worktree create/destroy hooks, agent launch profiles, and ACP adapter overrides.

treehouse never creates commits on your behalf. If a merge would be a no-op because changes are uncommitted, it reports that instead.

## Development

```sh
npm run gen-types                    # regenerate TS bindings after changing Rust #[derive(TS)] types
npx tsc -b                           # type-check
npm test                             # Vitest
cd src-tauri && cargo test --quiet   # Rust tests
npx playwright test                  # UI tests against a stubbed Tauri IPC layer
```

See [`CLAUDE.md`](./CLAUDE.md) for architecture, module layout, and conventions.

## License

MIT
