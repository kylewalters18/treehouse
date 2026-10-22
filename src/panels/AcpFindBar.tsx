import { createContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

/// The open find bar's query, lowercased; "" when closed or empty. Rows
/// that fold content (tool runs, tool bodies, thoughts) open while it
/// matches them, so every hit is in the DOM to highlight.
export const FindQueryContext = createContext("");

/// Every case-insensitive occurrence of `query` in `root`'s text, in
/// document order. A match must sit inside one text node; formatting that
/// splits a phrase (bold mid-word) can hide it.
export function findRanges(root: Node, query: string): Range[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? "").toLowerCase();
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
      const r = doc.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + needle.length);
      out.push(r);
    }
  }
  return out;
}

/// Ranges each open find bar highlights, merged into the two CSS custom
/// highlights `styles.css` paints (`::highlight(acp-find)`, `-current`).
const highlightSets = new Map<string, { all: Range[]; current: Range | null }>();

function paintHighlights() {
  const reg = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  if (!reg || typeof Highlight === "undefined") return;
  const all = [...highlightSets.values()];
  reg.set("acp-find", new Highlight(...all.flatMap((s) => s.all)));
  reg.set("acp-find-current", new Highlight(...all.flatMap((s) => (s.current ? [s.current] : []))));
}

/// ⌘F over an ACP transcript: a small bar at the transcript's top right.
/// ⏎ / ⇧⏎ walk hits (wrapping), Esc closes. Hits re-collect as the
/// transcript streams or re-renders (highlighting lands async).
export function AcpFindBar({
  scrollRef,
  query,
  onQuery,
  focusNonce,
  onClose,
  onNavigate,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  query: string;
  onQuery: (q: string) => void;
  /// Bumped to focus (and select) the field again — ⌘F while open.
  focusNonce: number;
  onClose: () => void;
  /// A hit was scrolled to: the transcript stops following the bottom.
  onNavigate: () => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [ranges, setRanges] = useState<Range[]>([]);
  const [current, setCurrent] = useState(0);
  // Re-collect on a new query from the hit nearest the viewport's top;
  // on transcript changes, keep the position.
  const fromTop = useRef(true);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  useEffect(() => {
    fromTop.current = true;
  }, [query]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const collect = () => {
      frame = 0;
      const found = findRanges(el, query);
      setRanges(found);
      if (fromTop.current) {
        fromTop.current = false;
        const top = el.getBoundingClientRect().top;
        const i = found.findIndex((r) => r.getBoundingClientRect().top >= top);
        setCurrent(i >= 0 ? i : 0);
        if (found.length) reveal(found[i >= 0 ? i : 0]);
      } else {
        setCurrent((c) => Math.min(c, Math.max(0, found.length - 1)));
      }
    };
    collect();
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(collect);
    });
    mo.observe(el, { subtree: true, childList: true, characterData: true });
    return () => {
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRef, query]);

  useEffect(() => {
    highlightSets.set(id, { all: ranges, current: ranges[current] ?? null });
    paintHighlights();
  }, [id, ranges, current]);
  useEffect(
    () => () => {
      highlightSets.delete(id);
      paintHighlights();
    },
    [id],
  );

  /// Scroll `r` into view when it's off screen, a third of the way down.
  function reveal(r: Range) {
    const el = scrollRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const at = r.getBoundingClientRect();
    if (at.top >= box.top + 32 && at.bottom <= box.bottom) return;
    el.scrollTop += at.top - box.top - box.height / 3;
  }

  function step(d: 1 | -1) {
    if (ranges.length === 0) return;
    const next = (current + d + ranges.length) % ranges.length;
    setCurrent(next);
    onNavigate();
    reveal(ranges[next]);
  }

  const count = query ? (ranges.length ? `${current + 1}/${ranges.length}` : "No results") : "";
  return (
    <div
      role="search"
      className="absolute right-3 top-2 z-30 flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900/95 py-1 pl-2 pr-1 shadow-xl shadow-black/40"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder="Find in transcript"
        aria-label="Find in transcript"
        spellCheck={false}
        className="w-44 bg-transparent text-[12px] text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
      />
      <span className="min-w-[3.5rem] text-right text-[10.5px] tabular-nums text-neutral-500">{count}</span>
      {[
        { d: -1 as const, icon: ChevronUp, label: "Previous match (⇧⏎)" },
        { d: 1 as const, icon: ChevronDown, label: "Next match (⏎)" },
      ].map(({ d, icon: Icon, label }) => (
        <button
          key={d}
          onClick={() => step(d)}
          disabled={ranges.length === 0}
          title={label}
          aria-label={label}
          className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Icon size={12} />
        </button>
      ))}
      <button
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close find"
        className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100"
      >
        <X size={12} />
      </button>
    </div>
  );
}
