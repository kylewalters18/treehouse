/// Prompt-box text handling for ACP agents: the `@file` / `/command` token
/// under the caret (for autocomplete), applying a completion, and the files
/// a prompt mentions (sent as attachments).

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
/// return the new text and where the caret goes.
export function applyCompletion(
  text: string,
  token: PromptToken,
  value: string,
): { text: string; caret: number } {
  const sigil = token.kind === "file" ? "@" : "/";
  const insert = `${sigil}${value} `;
  const after = text.slice(token.end).replace(/^ /, "");
  return { text: text.slice(0, token.start) + insert + after, caret: token.start + insert.length };
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
