import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Highlighter } from "shiki";
import { Check, Copy } from "lucide-react";

import { getMarkdownHighlighter, highlightCode } from "@/panels/markdown-shiki";
import { cn } from "@/lib/cn";

let loaded: Highlighter | null = null;

/// The markdown Shiki highlighter (shared with MarkdownPreview), or null
/// until its one-time load finishes.
export function useMarkdownHighlighter(): Highlighter | null {
  const [h, setH] = useState<Highlighter | null>(loaded);
  useEffect(() => {
    if (h) return;
    let live = true;
    void getMarkdownHighlighter().then((x) => {
      loaded = x;
      if (live) setH(x);
    });
    return () => {
      live = false;
    };
  }, [h]);
  return h;
}

/// Language for a file path's fence, by extension — for diffs and file
/// reads where the agent doesn't say. Unknown → plain text.
export function langForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    rs: "rust",
    py: "python",
    go: "go",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    rb: "ruby",
    lua: "lua",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    toml: "toml",
    yml: "yaml",
    yaml: "yaml",
    json: "json",
    md: "markdown",
    sh: "bash",
    zsh: "zsh",
    sql: "sql",
    html: "html",
    css: "css",
    scss: "scss",
    xml: "xml",
    graphql: "graphql",
  };
  return map[ext] ?? "text";
}

/// Where a wrapped line's continuation starts, in ch: its own indentation
/// (tabs at 4, matching `tab-size` in styles.css; past a diff's +/-
/// marker) — like VS Code's `wrappingIndent: "same"`. CodeBlock adds a
/// 2ch hanging indent on top so continuations don't read as siblings.
export function lineIndents(code: string, lang?: string): number[] {
  const skip = lang === "diff" ? 1 : 0;
  return code.split("\n").map((line) => {
    let w = skip;
    for (let i = skip; i < line.length; i++) {
      if (line[i] === " ") w += 1;
      else if (line[i] === "\t") w += 4 - ((w - skip) % 4);
      else return w;
    }
    // Blank / whitespace-only lines never wrap.
    return 0;
  });
}

/// Rendered height of one line in a `.shiki` block (12.5px × 1.6) and its
/// vertical padding — for collapsing to a line count. `compact` blocks
/// match `.code-compact` in styles.css.
const LINE_PX = 20;
const PAD_PX = 24;
const COMPACT_LINE_PX = 18;
const COMPACT_PAD_PX = 14;

/// A highlighted code block with a copy button (on hover). `lang` is a
/// fence language; unknown languages render plain. Copies `code` as-is.
/// With `maxLines`, taller code starts collapsed behind a "Show all" toggle
/// rather than scrolling inside its own box. Long lines soft-wrap with a
/// hanging indent past their own indentation, so the block never widens
/// its container or scrolls sideways; "taller" is measured after wrapping.
/// Multi-line non-diff code gets a line-number gutter, so a wrapped row
/// (no number) is distinguishable from a new line. `compact` is the
/// denser size for tool output.
export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  className,
  maxLines,
  compact = false,
}: {
  code: string;
  lang?: string;
  className?: string;
  maxLines?: number;
  compact?: boolean;
}) {
  const highlighter = useMarkdownHighlighter();
  const indents = useMemo(() => lineIndents(code, lang), [code, lang]);
  const html = useMemo(
    () => (highlighter && lang ? highlightCode(highlighter, code, lang, indents) : null),
    [highlighter, code, lang, indents],
  );
  const lineCount = indents.length;
  const numbered = lineCount > 1 && lang !== "diff";
  const linePx = compact ? COMPACT_LINE_PX : LINE_PX;
  const maxHeight = (maxLines ?? 0) * linePx + (compact ? COMPACT_PAD_PX : PAD_PX);
  // Wrapped lines make the text's line count a poor guide to height, so
  // measure: collapse only when the content runs 2+ lines past the cap.
  const contentRef = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (maxLines === undefined || !el) return;
    const measure = () => setTall(el.offsetHeight > maxHeight + 2 * linePx);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxLines, maxHeight, linePx]);
  const collapsible = maxLines !== undefined && tall;
  const [expanded, setExpanded] = useState(false);
  const collapsed = collapsible && !expanded;
  const fill = compact ? "#0F1114" : "#16191D";
  return (
    <div
      className={cn(
        "shiki-block code-block group relative min-w-0 max-w-full",
        compact && "code-compact",
        className,
      )}
    >
      <div className={cn(collapsed && "overflow-hidden")} style={collapsed ? { maxHeight } : undefined}>
        <div
          ref={contentRef}
          className={cn(numbered && "code-numbered")}
          style={numbered ? ({ "--gutter": String(lineCount).length } as React.CSSProperties) : undefined}
        >
          {html ? (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className="shiki">
              <code>
                {code.split("\n").map((line, i) => (
                  <span key={i} className="line" style={{ "--indent": indents[i] } as React.CSSProperties}>
                    {line}
                  </span>
                ))}
              </code>
            </pre>
          )}
        </div>
      </div>
      {collapsible && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className={cn(
            "flex w-full items-center justify-center border-t border-neutral-800 py-1 text-[11px] text-neutral-500 transition-colors hover:text-neutral-200",
            collapsed && "relative -mt-6 border-t-0 pt-5",
          )}
          style={
            collapsed
              ? { background: `linear-gradient(to bottom, transparent, ${fill}e6 40%, ${fill})` }
              : undefined
          }
        >
          {collapsed ? `Show all ${lineCount} lines` : "Collapse"}
        </button>
      )}
      <CopyButton text={code} />
    </div>
  );
});

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable — nothing useful to surface */
        }
      }}
      title={copied ? "Copied" : "Copy"}
      aria-label="Copy code"
      className={cn(
        "absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md bg-neutral-900/90 text-neutral-500 opacity-0 transition-opacity hover:bg-neutral-800 hover:text-neutral-100 focus:opacity-100 group-hover:opacity-100",
        copied && "text-emerald-400 opacity-100",
        className,
      )}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
