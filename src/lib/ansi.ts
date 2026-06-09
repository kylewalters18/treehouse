/// Minimal ANSI parser for CI job logs (GitLab traces). Converts a raw trace
/// — SGR color codes, erase-line sequences, GitLab `section_start/end`
/// markers, progress carriage-returns — into either styled segments (for the
/// log viewer) or clean plain text (for embedding in an agent prompt).
///
/// Dependency-free on purpose: the project re-implements editor-adjacent bits
/// rather than pull libraries, and a focused SGR parser is small. It covers
/// the 16-color + 256-color + truecolor + bold/dim/italic/underline subset CI
/// runners actually emit; anything else (cursor moves, other CSI verbs) is
/// stripped rather than rendered.

export type AnsiStyle = {
  color?: string;
  backgroundColor?: string;
  fontWeight?: "bold";
  fontStyle?: "italic";
  textDecoration?: "underline";
  opacity?: number;
};

export type AnsiSegment = { text: string; style?: AnsiStyle };

/// Readable-on-black 16-color palette (codes 0–7 normal, 8–15 bright).
const PALETTE = [
  "#3b3b3b", "#f87171", "#4ade80", "#fbbf24",
  "#60a5fa", "#c084fc", "#22d3ee", "#d4d4d4",
  "#6b7280", "#fca5a5", "#86efac", "#fde047",
  "#93c5fd", "#d8b4fe", "#67e8f9", "#ffffff",
];

/// xterm 256-color index → CSS color.
function color256(n: number): string {
  if (n < 16) return PALETTE[n];
  if (n <= 231) {
    const x = n - 16;
    const conv = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${conv(Math.floor(x / 36))},${conv(Math.floor((x % 36) / 6))},${conv(x % 6)})`;
  }
  const v = 8 + (n - 232) * 10; // grayscale ramp 232–255
  return `rgb(${v},${v},${v})`;
}

type State = {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
};

function freshState(): State {
  // Explicit fg/bg undefined so `Object.assign(state, freshState())` on a
  // reset (SGR 0) actually clears a prior color, not just the flags.
  return { fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false };
}

function styleOf(s: State): AnsiStyle | undefined {
  const out: AnsiStyle = {};
  if (s.fg) out.color = s.fg;
  if (s.bg) out.backgroundColor = s.bg;
  if (s.bold) out.fontWeight = "bold";
  if (s.italic) out.fontStyle = "italic";
  if (s.underline) out.textDecoration = "underline";
  if (s.dim) out.opacity = 0.6;
  return Object.keys(out).length ? out : undefined;
}

/// Apply a single SGR escape's parameters to the running state.
function applySgr(state: State, params: string): void {
  const codes = params === "" ? [0] : params.split(";").map((p) => parseInt(p, 10) || 0);
  for (let k = 0; k < codes.length; k++) {
    const c = codes[k];
    if (c === 0) Object.assign(state, freshState());
    else if (c === 1) state.bold = true;
    else if (c === 2) state.dim = true;
    else if (c === 3) state.italic = true;
    else if (c === 4) state.underline = true;
    else if (c === 22) { state.bold = false; state.dim = false; }
    else if (c === 23) state.italic = false;
    else if (c === 24) state.underline = false;
    else if (c === 39) state.fg = undefined;
    else if (c === 49) state.bg = undefined;
    else if (c >= 30 && c <= 37) state.fg = PALETTE[c - 30];
    else if (c >= 90 && c <= 97) state.fg = PALETTE[c - 90 + 8];
    else if (c >= 40 && c <= 47) state.bg = PALETTE[c - 40];
    else if (c >= 100 && c <= 107) state.bg = PALETTE[c - 100 + 8];
    else if (c === 38 || c === 48) {
      const mode = codes[k + 1];
      let col: string | undefined;
      if (mode === 5) { col = color256(codes[k + 2] ?? 0); k += 2; }
      else if (mode === 2) { col = `rgb(${codes[k + 2] ?? 0},${codes[k + 3] ?? 0},${codes[k + 4] ?? 0})`; k += 4; }
      if (col) { if (c === 38) state.fg = col; else state.bg = col; }
    }
  }
}

/// Strip GitLab section markers + normalize carriage returns. Runs before the
/// escape scan so the leftover CSI `[0K` erase-line codes are dropped by the
/// scanner. A lone `\r` (progress overwrite) is dropped; we don't simulate
/// cursor-column overwrites — CI text logs rarely need it.
function preclean(input: string): string {
  return input
    .replace(/section_(?:start|end):\d+:[A-Za-z0-9_.-]+\r?/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
}

/// Parse a raw trace into contiguous styled segments. Adjacent text sharing a
/// style stays in one segment; newlines are preserved (render inside a `<pre>`).
export function ansiToSegments(input: string): AnsiSegment[] {
  const text = preclean(input);
  const segments: AnsiSegment[] = [];
  const state = freshState();
  let buf = "";
  let i = 0;

  const flush = () => {
    if (!buf) return;
    segments.push({ text: buf, style: styleOf(state) });
    buf = "";
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === "\x1b" && text[i + 1] === "[") {
      let j = i + 2;
      while (j < text.length && !/[A-Za-z]/.test(text[j])) j++;
      if (text[j] === "m") {
        flush();
        applySgr(state, text.slice(i + 2, j));
      }
      // non-SGR CSI (erase-line `K`, cursor moves, …) → drop the whole seq
      i = j + 1;
      continue;
    }
    if (ch === "\x1b") { i++; continue; } // stray ESC
    buf += ch;
    i++;
  }
  flush();
  return segments;
}

/// Drop all ANSI/section noise, returning plain text. For agent prompts.
export function stripAnsi(input: string): string {
  return ansiToSegments(input)
    .map((s) => s.text)
    .join("");
}
