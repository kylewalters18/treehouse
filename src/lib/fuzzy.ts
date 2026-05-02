/// Tiny VS Code-style fuzzy subsequence matcher. Returns a numeric
/// score (higher = better) plus the matched character indices, or
/// `null` when the needle isn't a subsequence of the haystack at all.
///
/// Scoring rewards (in roughly this priority order):
///   - matches at word boundaries (`/`, `_`, `-`, `.`, capital after lower)
///   - consecutive runs of matched chars
///   - matches in the basename (last `/`-segment) over matches deeper
///     in the path
///   - earlier matches (so prefix matches outrank tail matches)
/// Penalises the gaps between matched characters.
///
/// Case-insensitive but boundary detection uses the ORIGINAL case so
/// `aP` against `AgentPane` still hits the capital boundary bonus.

export type FuzzyResult = {
  score: number;
  /// Indices into `haystack` (0-based) for each matched needle char,
  /// in order. Use this to highlight match positions in the UI.
  matches: number[];
};

// Tuned so a tight basename match (`foobar.ts` for `foo`) outranks a
// scattered match where every char happens to land on a boundary
// (`f-o-o-bar.ts` for `foo`). The consecutive bonus needs to exceed
// the boundary bonus per char so 3-in-a-row beats 3-boundaries.
const SCORE_BOUNDARY = 20;
const SCORE_CONSECUTIVE = 25;
const SCORE_BASENAME_BONUS = 10;
const SCORE_FIRST_CHAR = 10;
const PENALTY_PER_GAP_CHAR = 1;

export function fuzzyScore(
  haystack: string,
  needle: string,
): FuzzyResult | null {
  if (needle.length === 0) return { score: 0, matches: [] };
  if (needle.length > haystack.length) return null;

  const hLower = haystack.toLowerCase();
  const nLower = needle.toLowerCase();

  // Greedy left-to-right subsequence walk. For each needle char, find
  // the next occurrence in haystack from the current position. This
  // doesn't always pick the highest-scoring assignment (a later
  // occurrence might land at a stronger boundary), but for the
  // typical Cmd+P workload it produces near-optimal rankings at a
  // fraction of the runtime cost of full DP.
  const matches: number[] = [];
  let hi = 0;
  for (let ni = 0; ni < nLower.length; ni++) {
    const c = nLower[ni];
    let found = -1;
    while (hi < hLower.length) {
      if (hLower[hi] === c) {
        found = hi;
        hi++;
        break;
      }
      hi++;
    }
    if (found < 0) return null;
    matches.push(found);
  }

  let score = 0;
  const basenameStart = haystack.lastIndexOf("/") + 1;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const ch = haystack[m];
    const prev = m > 0 ? haystack[m - 1] : "";
    const isBoundary =
      m === 0 ||
      prev === "/" ||
      prev === "_" ||
      prev === "-" ||
      prev === "." ||
      (isLower(prev) && isUpper(ch));
    if (isBoundary) score += SCORE_BOUNDARY;
    if (m === 0) score += SCORE_FIRST_CHAR;
    if (m >= basenameStart) score += SCORE_BASENAME_BONUS;
    if (i > 0 && matches[i - 1] === m - 1) score += SCORE_CONSECUTIVE;
    if (i > 0) {
      const gap = m - matches[i - 1] - 1;
      score -= gap * PENALTY_PER_GAP_CHAR;
    }
  }
  return { score, matches };
}

function isUpper(c: string): boolean {
  return c >= "A" && c <= "Z";
}
function isLower(c: string): boolean {
  return c >= "a" && c <= "z";
}

/// Top-N matches sorted by score descending; ties broken by shorter
/// haystack (so `Foo.ts` beats `FooHelperLongName.ts` for `foo`).
export function fuzzyFilter<T>(
  items: T[],
  needle: string,
  toString: (item: T) => string,
  limit: number,
): { item: T; score: number; matches: number[] }[] {
  if (!needle) {
    // Empty query: return the first N items in their natural order so
    // the picker isn't blank on first open.
    return items.slice(0, limit).map((item) => ({ item, score: 0, matches: [] }));
  }
  const scored: {
    item: T;
    score: number;
    matches: number[];
    len: number;
  }[] = [];
  for (const item of items) {
    const s = toString(item);
    const r = fuzzyScore(s, needle);
    if (r) scored.push({ item, score: r.score, matches: r.matches, len: s.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return scored.slice(0, limit).map(({ item, score, matches }) => ({
    item,
    score,
    matches,
  }));
}
