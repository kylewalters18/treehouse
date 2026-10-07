import { memo, useEffect, useMemo, useState } from "react";
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

/// Rendered height of one line in a `.shiki` block (12.5px × 1.6) and its
/// vertical padding — for collapsing to a line count.
const LINE_PX = 20;
const PAD_PX = 24;

/// A highlighted code block with a copy button (on hover). `lang` is a
/// fence language; unknown languages render plain. Copies `code` as-is.
/// With `maxLines`, longer code starts collapsed behind a "Show all" toggle
/// rather than scrolling inside its own box. Long lines scroll sideways
/// inside the block; it never widens its container.
export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  className,
  maxLines,
}: {
  code: string;
  lang?: string;
  className?: string;
  maxLines?: number;
}) {
  const highlighter = useMarkdownHighlighter();
  const html = useMemo(
    () => (highlighter && lang ? highlightCode(highlighter, code, lang) : null),
    [highlighter, code, lang],
  );
  const lineCount = useMemo(() => code.split("\n").length, [code]);
  const collapsible = maxLines !== undefined && lineCount > maxLines + 2;
  const [expanded, setExpanded] = useState(false);
  const collapsed = collapsible && !expanded;
  return (
    <div className={cn("shiki-block code-block group relative min-w-0 max-w-full", className)}>
      <div
        className={cn(collapsed && "overflow-hidden")}
        style={collapsed ? { maxHeight: (maxLines ?? 0) * LINE_PX + PAD_PX } : undefined}
      >
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="shiki">
            <code>{code}</code>
          </pre>
        )}
      </div>
      {collapsible && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className={cn(
            "flex w-full items-center justify-center border-t border-[#22262B] py-1 text-[11px] text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200",
            collapsed && "relative -mt-6 border-t-0 bg-gradient-to-b from-transparent via-[#16191D]/90 to-[#16191D] pt-5",
          )}
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
        "absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded border border-neutral-700 bg-neutral-900/90 text-neutral-400 opacity-0 transition-opacity hover:text-neutral-100 focus:opacity-100 group-hover:opacity-100",
        copied && "text-emerald-400 opacity-100",
        className,
      )}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
