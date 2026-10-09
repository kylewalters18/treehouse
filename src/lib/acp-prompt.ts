/// Prompt-box text handling for ACP agents: the `@file` / `/command` token
/// under the caret (for autocomplete), applying a completion, and the files
/// a prompt mentions (sent as attachments).

import { fuzzyFilter } from "@/lib/fuzzy";

export type PromptToken = {
  kind: "file" | "command";
  /// Text after the `@` / `/`, up to the caret.
  query: string;
  /// Range of the whole token (including the sigil) in the text.
  start: number;
  end: number;
};

/// The completable token the caret is in, if any. `@file` works anywhere
/// at a word start; `/command` only as the prompt's first word (that's
/// where agents look for it).
export function activeToken(text: string, caret: number): PromptToken | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  const word = text.slice(start, caret);
  if (word.startsWith("@")) {
    return { kind: "file", query: word.slice(1), start, end };
  }
  if (word.startsWith("/") && text.slice(0, start).trim() === "") {
    return { kind: "command", query: word.slice(1), start, end };
  }
  return null;
}

/// Replace `token` with the chosen completion plus a trailing space, and
/// return the new text and where the caret goes. A directory (`dir/`)
/// gets no space, so completion carries on into it.
export function applyCompletion(
  text: string,
  token: PromptToken,
  value: string,
): { text: string; caret: number } {
  const sigil = token.kind === "file" ? "@" : "/";
  const intoDir = token.kind === "file" && value.endsWith("/");
  const insert = `${sigil}${value}${intoDir ? "" : " "}`;
  const after = intoDir ? text.slice(token.end) : text.slice(token.end).replace(/^ /, "");
  return { text: text.slice(0, token.start) + insert + after, caret: token.start + insert.length };
}

/// One `@` completion: a file, or a directory (`path` ends in `/`).
export type PathEntry = { path: string; dir: boolean };

/// The worktree's files and the directories above them, for `@` completion.
export type PathIndex = {
  all: PathEntry[];
  /// Directory (`""` = root, else `dir/`) → its direct children.
  children: Map<string, PathEntry[]>;
};

export function buildPathIndex(files: readonly string[]): PathIndex {
  const children = new Map<string, PathEntry[]>([["", []]]);
  const all: PathEntry[] = [];
  for (const file of files) {
    let parent = "";
    const parts = file.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = `${parent}${parts[i]}/`;
      if (!children.has(dir)) {
        children.set(dir, []);
        const entry = { path: dir, dir: true };
        children.get(parent)!.push(entry);
        all.push(entry);
      }
      parent = dir;
    }
    const entry = { path: file, dir: false };
    children.get(parent)!.push(entry);
    all.push(entry);
  }
  const byName = (a: PathEntry, b: PathEntry) =>
    Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path);
  for (const list of children.values()) list.sort(byName);
  return { all, children };
}

/// Suggestions for an `@` query, shell-style: under a known directory
/// (`src/pa`) they're that directory's entries matching the rest, else a
/// fuzzy match over every path. An empty rest lists the directory, folders
/// first.
export function pathSuggestions(
  index: PathIndex,
  query: string,
  limit: number,
): PathEntry[] {
  const fuzzy = (items: PathEntry[], needle: string, name: (e: PathEntry) => string) =>
    fuzzyFilter(items, needle, name, limit).map((r) => r.item);
  const slash = query.lastIndexOf("/");
  const dir = query.slice(0, slash + 1);
  const rest = query.slice(slash + 1);
  const listing = index.children.get(dir);
  if (listing && (dir || !rest)) {
    if (!rest) return listing.slice(0, limit);
    // Match the entry's own name, not the directory both share.
    const hits = fuzzy(listing, rest, (e) => e.path.slice(dir.length));
    if (hits.length > 0) return hits;
  }
  return fuzzy(index.all, query, (e) => e.path);
}

/// Worktree files mentioned as `@path` in `text`, in order, deduplicated.
/// Only paths in `known` count, so an email address or `@decorator`
/// stays plain text.
export function mentionedFiles(text: string, known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) {
    // Trailing punctuation from prose ("see @src/lib.rs.") isn't the path.
    const path = m[1].replace(/[.,;:!?)]+$/, "");
    if (known.has(path) && !out.includes(path)) out.push(path);
  }
  return out;
}

/// `50k / 200k` style token count.
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/// Prompts the user has sent, oldest first, for ↑/↓ recall: non-empty,
/// with immediate repeats collapsed.
export function promptHistory(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of texts) {
    const t = raw.trim();
    if (t && out[out.length - 1] !== t) out.push(t);
  }
  return out;
}

/// One step through history from `index` (null = the live draft): `-1`
/// goes older, `1` newer. Returns the new index, null for back at the
/// draft, or `index` unchanged at the oldest end.
export function historyStep(length: number, index: number | null, dir: -1 | 1): number | null {
  if (length === 0) return null;
  if (index === null) return dir === -1 ? length - 1 : null;
  const next = index + dir;
  if (next < 0) return index;
  return next >= length ? null : next;
}

/// Whether the caret is on the text's first / last line — where ↑ / ↓
/// leave the textarea's own line movement and walk history instead.
export function caretOnEdgeLine(text: string, caret: number, edge: "first" | "last"): boolean {
  return edge === "first" ? !text.slice(0, caret).includes("\n") : !text.slice(caret).includes("\n");
}
