import { homeDir } from "@tauri-apps/api/path";
import type { IDisposable, ILink, Terminal } from "xterm";
import { openExternalUrl } from "@/ipc/client";
import type { WorktreeId } from "@/ipc/types";
import { useDiffsStore } from "@/stores/diffs";
import { useWorktreesStore } from "@/stores/worktrees";

/// xterm link provider for filesystem paths in terminal/agent output.
/// Cmd+click (Ctrl+click on non-mac) opens the path in the EditorPane;
/// plain click is a no-op so users can still select text. Hover shows
/// a pointer cursor with underline so paths are visibly clickable.
///
/// Recognises:
/// - absolute paths inside the worktree (`/Users/.../repo/src/foo.ts`)
/// - worktree-relative paths (`src/foo.ts`, `./src/foo.ts`)
/// - optional `:line` or `:line:col` suffix (TS/Rust/Node stack-trace shape)
///
/// Bare filenames without slashes are NOT matched — too many false
/// positives in non-path output (`package.json` mentioned in prose,
/// `2.5MB`, version strings). Users with bare filenames can still open
/// them via the file tree.

/// Single combined link provider for both URLs and paths. xterm
/// queries providers in registration order and uses the first
/// non-undefined result per line — registering URL and path as
/// separate providers means a line containing a URL would suppress
/// path matches on the same line. One provider that returns the
/// merged set sidesteps that and lets us strip path matches that
/// overlap URL ranges (e.g. `example.com/foo` inside
/// `https://example.com/foo` should belong to the URL link, not a
/// false-positive path link).
export function registerTerminalLinks(
  term: Terminal,
  worktreeId: WorktreeId,
): IDisposable {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer.active;
      const line = buffer.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const links = combinedLinksForLine(text, bufferLineNumber, worktreeId);
      // Pass `undefined` (not an empty array) when there's nothing —
      // empty array short-circuits xterm's provider chain so any
      // future providers wouldn't get a turn.
      callback(links.length > 0 ? links : undefined);
    },
  });
}

/// URL and path links for one line, with URL ranges taking
/// precedence: any path match that overlaps a URL range is dropped.
export function combinedLinksForLine(
  text: string,
  bufferLineNumber: number,
  worktreeId: WorktreeId,
): ILink[] {
  const urls = urlLinksForLine(text, bufferLineNumber);
  // Build inclusive cell ranges of URL matches so we can filter
  // overlapping path matches out. `range.start.x` and `range.end.x`
  // are 1-based and inclusive.
  const urlRanges = urls.map((u) => [u.range.start.x, u.range.end.x] as const);
  const paths = linksForLine(text, bufferLineNumber, worktreeId).filter((p) => {
    const ps = p.range.start.x;
    const pe = p.range.end.x;
    return !urlRanges.some(([us, ue]) => ps <= ue && us <= pe);
  });
  return [...urls, ...paths];
}

/// Path matcher. Three alternatives joined by `|`:
///   1. Absolute or `~/`:       `(/|~/)word(/word)*`
///   2. Relative with a `/`:    `(\./|../)?word(/word)+`
///   3. Bare filename + ext:    `word.letter\w*`
/// Each may carry a trailing `:line` or `:line:col`. Word chars are
/// `[\p{L}\p{N}_.+@-]` (the `u` flag turns `\p{L}\p{N}` into "any
/// unicode letter / digit") so `node_modules`, `kebab-case`,
/// `.dotfile`, `.tsx`, `C++`, `@types/node`, `Café/foo.ts`, etc. all
/// flow through.
///
/// The bare-filename branch deliberately requires the extension to
/// start with a LETTER (`\p{L}`) — this rejects version strings like
/// `2.5.1` and decimals like `0.42` while still catching every
/// realistic source-file extension (`ts`, `py`, `rs`, `go`, `md`,
/// `json`, etc.).
///
/// The `~/` prefix is matched here so links visually highlight; the
/// activate path expands `~` against the user's home dir before
/// resolving against the worktree root (see `openPathInEditor`).
const PATH_REGEX =
  /(?:(?:\/|~\/)[\p{L}\p{N}_.+@-]+(?:\/[\p{L}\p{N}_.+@-]+)*|(?:\.{1,2}\/)?[\p{L}\p{N}_.+@-]+(?:\/[\p{L}\p{N}_.+@-]+)+|[\p{L}\p{N}_+@-]+\.\p{L}[\p{L}\p{N}_]*)(?::\d+(?::\d+)?)?/gu;

export function linksForLine(
  text: string,
  bufferLineNumber: number,
  worktreeId: WorktreeId,
): ILink[] {
  const links: ILink[] = [];
  for (const match of text.matchAll(PATH_REGEX)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    links.push({
      // Cells are 1-based. Range is inclusive on both ends per xterm's
      // convention (start.x is the first cell, end.x is the last cell).
      range: {
        start: { x: start + 1, y: bufferLineNumber },
        end: { x: end, y: bufferLineNumber },
      },
      text: match[0],
      decorations: { pointerCursor: true, underline: true },
      activate(event, text) {
        // Cmd (mac) / Ctrl (linux/windows) gates activation so plain
        // click is still a normal terminal interaction. Without this
        // gate, accidentally clicking a path while selecting text
        // would yank the user away from their terminal flow.
        if (!event.metaKey && !event.ctrlKey) return;
        void openPathInEditor(text, worktreeId);
      },
    });
  }
  return links;
}

/// Split an optional `:line` or `:line:col` suffix off a path string.
/// `:line` and `:col` are 1-based to match Monaco. Returns column 1 if
/// only line is given (matches the user's mental model of "go to that
/// line"). Lines without numeric suffixes pass through unchanged.
export function parsePathWithLineCol(raw: string): {
  path: string;
  line: number | null;
  column: number | null;
} {
  const m = raw.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!m) return { path: raw, line: null, column: null };
  return {
    path: m[1],
    line: parseInt(m[2], 10),
    column: m[3] ? parseInt(m[3], 10) : 1,
  };
}

/// Resolve a (possibly absolute, possibly with leading `./` or `~/`)
/// path to a worktree-relative form. Returns `null` for absolute paths
/// that aren't under the worktree — the EditorPane reads files
/// relative to the worktree root, so out-of-tree paths can't be opened
/// from here.
///
/// When `homeDirPath` is provided, leading `~/` is expanded to it
/// before the under-worktree check; without it, `~/`-paths fall
/// through and almost certainly fail the prefix check (returned as
/// `null`), which matches the "not in this worktree" semantic.
export function resolveToWorktreeRelative(
  rawPath: string,
  worktreePath: string,
  homeDirPath?: string | null,
): string | null {
  let path = rawPath;
  if (homeDirPath && path.startsWith("~/")) {
    const home = homeDirPath.endsWith("/")
      ? homeDirPath.slice(0, -1)
      : homeDirPath;
    path = home + path.slice(1);
  }
  if (path.startsWith("/")) {
    const root = worktreePath.endsWith("/")
      ? worktreePath
      : worktreePath + "/";
    if (path === worktreePath) return "";
    if (!path.startsWith(root)) return null;
    return path.slice(root.length);
  }
  if (path.startsWith("./")) return path.slice(2);
  return path;
}

/// http/https URL matcher. Permissive on the path component but
/// strict on the scheme — file://, ftp://, etc. have different open
/// semantics and are easier to get wrong; add on demand. The negative
/// lookahead `[^\s)]` stops at whitespace or a closing paren so a URL
/// in `(see https://x.com/foo)` doesn't include the trailing `)`.
const URL_REGEX = /https?:\/\/[^\s)>"']+/g;

/// Punctuation that's unlikely to be part of a real URL but is common
/// in trailing position from prose: `https://x.com/foo.` or `https://
/// x.com/foo!`. We strip these from the right edge before producing
/// the link.
const TRAILING_PUNCT = /[.,;:!?]+$/;

export function urlLinksForLine(
  text: string,
  bufferLineNumber: number,
): ILink[] {
  const links: ILink[] = [];
  for (const match of text.matchAll(URL_REGEX)) {
    if (match.index === undefined) continue;
    let url = match[0];
    const trim = url.match(TRAILING_PUNCT);
    if (trim) url = url.slice(0, url.length - trim[0].length);
    const start = match.index;
    const end = start + url.length;
    links.push({
      range: {
        start: { x: start + 1, y: bufferLineNumber },
        end: { x: end, y: bufferLineNumber },
      },
      text: url,
      decorations: { pointerCursor: true, underline: true },
      activate(event, text) {
        if (!event.metaKey && !event.ctrlKey) return;
        void openExternalUrl(text).catch((e) => {
          console.warn("[term-links] open external failed", text, e);
        });
      },
    });
  }
  return links;
}

/// Cached home dir lookup. Tauri's `homeDir()` round-trips to Rust;
/// the value is invariant across a session, so we hold the Promise
/// once and let every caller await the same resolution. On failure we
/// cache `null` rather than retrying — the worst case is `~/`-paths
/// stop opening, which is a graceful degrade.
let homeDirPromise: Promise<string | null> | null = null;
function getHomeDir(): Promise<string | null> {
  if (!homeDirPromise) {
    homeDirPromise = homeDir().catch(() => null);
  }
  return homeDirPromise;
}

async function openPathInEditor(
  raw: string,
  worktreeId: WorktreeId,
): Promise<void> {
  const { path, line, column } = parsePathWithLineCol(raw);
  const worktree = useWorktreesStore
    .getState()
    .worktrees.find((w) => w.id === worktreeId);
  if (!worktree) return;
  const home = path.startsWith("~/") ? await getHomeDir() : null;
  const rel = resolveToWorktreeRelative(path, worktree.path, home);
  if (rel === null) return;
  const diffs = useDiffsStore.getState();
  diffs.setView(worktreeId, "file");
  diffs.selectFile(worktreeId, rel);
  if (line !== null) {
    diffs.setPendingReveal(worktreeId, {
      path: rel,
      line,
      column: column ?? 1,
    });
  } else {
    diffs.setPendingReveal(worktreeId, null);
  }
}
