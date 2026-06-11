/// Split a command line into an argv array, honoring single/double quotes
/// and backslash escapes — enough to let users type things like
/// `claude --agent "code reviewer"` in the agent launch command field.
///
/// Rules (a pragmatic subset of POSIX shell word-splitting):
/// - Unquoted whitespace (space/tab/newline) separates words.
/// - Single quotes preserve everything literally until the next `'`.
/// - Double quotes preserve everything except `\` which escapes the next
///   char (so `"a\"b"` → `a"b`).
/// - A backslash outside quotes escapes the next char literally.
/// - Empty quotes (`''` / `""`) produce an empty-string argument.
/// - An unterminated quote is tolerated: its run extends to end-of-input.
export function splitCommand(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  // Tracks whether the current token has begun — distinguishes `""` (one
  // empty arg) from a run of whitespace (no arg).
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (quote === '"' && c === "\\" && i + 1 < input.length) {
        i += 1;
        cur += input[i];
      } else {
        cur += c;
      }
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < input.length) {
      i += 1;
      cur += input[i];
      started = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}
