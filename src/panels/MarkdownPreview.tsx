/// GitHub-flavored markdown preview for `.md` / `.mdx` files.
///
/// Uses `react-markdown` + `remark-gfm` so tables, task lists, strikethrough,
/// and autolinks all render. Code fences run through Shiki with the Dark+
/// theme so highlighted blocks match the editor's tokenization. Styled via
/// Tailwind's `prose` utilities (dark variant); code-block colors come
/// straight from Shiki so the `prose` defaults don't fight the highlight.

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Highlighter } from "shiki";
import { readFile } from "@/ipc/client";
import { onDiffUpdated } from "@/ipc/client";
import type { FileContent, WorktreeId } from "@/ipc/types";
import { asMessage } from "@/lib/errors";
import { getMarkdownHighlighter, highlightCode } from "./markdown-shiki";
import { renderMermaid } from "./markdown-mermaid";

type Props = {
  worktreeId: WorktreeId;
  path: string;
};

export function MarkdownPreview({ worktreeId, path }: Props) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Shiki sets up async (WASM + grammar load). Hold render until it
  // resolves so code blocks paint highlighted on first frame instead
  // of flashing plain then re-rendering.
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getMarkdownHighlighter().then((h) => {
      if (!cancelled) setHighlighter(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      try {
        const c = await readFile(worktreeId, path);
        if (!cancelled) setContent(c);
      } catch (e) {
        if (!cancelled) setError(asMessage(e));
      }
    };
    void fetch();

    // Live-refresh on agent writes, same pattern as EditorPane.
    let unlisten: (() => void) | null = null;
    onDiffUpdated(worktreeId, (diff) => {
      if (cancelled) return;
      if (!diff.files.some((f) => f.path === path)) return;
      void fetch();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [worktreeId, path]);

  if (error) {
    return (
      <div className="m-3 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
        {error}
      </div>
    );
  }
  if (!content) return null;
  if (content.binary || content.text === null) {
    return (
      <div className="m-3 rounded border border-neutral-800 bg-neutral-900/60 p-4 text-center text-xs text-neutral-500">
        Cannot preview this file.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-neutral-950 px-6 py-4">
      <article className="prose prose-invert prose-sm max-w-3xl">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={codeComponents(highlighter)}
        >
          {content.text}
        </ReactMarkdown>
      </article>
    </div>
  );
}

/// react-markdown component overrides for inline + fenced code. Inline
/// code stays a styled `<code>`; fenced blocks (those with a
/// `language-X` className from remark) get Shiki HTML injected.
function codeComponents(highlighter: Highlighter | null) {
  return {
    code(props: {
      className?: string;
      children?: React.ReactNode;
    }) {
      const { className, children } = props;
      const match = /language-(\w+)/.exec(className ?? "");
      // Inline code (no language fence) — keep as a small bordered chip.
      if (!match) {
        return (
          <code className="rounded border border-neutral-800 bg-neutral-900 px-1 py-0.5 text-[0.875em] text-neutral-200">
            {children}
          </code>
        );
      }
      const code = String(children ?? "").replace(/\n$/, "");
      // Mermaid fences render as diagrams, not highlighted source.
      if (match[1] === "mermaid") {
        return <MermaidDiagram chart={code} />;
      }
      // Highlighter still loading — render plain so the file is at
      // least readable; the next render after the highlighter
      // resolves will replace this with the highlighted version.
      if (!highlighter) {
        return (
          <pre className="shiki-pending overflow-x-auto rounded border border-neutral-800 bg-neutral-900 p-3 text-xs text-neutral-200">
            <code>{code}</code>
          </pre>
        );
      }
      const html = highlightCode(highlighter, code, match[1]);
      return (
        <div
          className="shiki-block overflow-x-auto rounded border border-neutral-800 text-xs"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    },
    // `pre` from react-markdown wraps fenced `<code>`; default styles
    // from `prose` add their own background which collides with
    // Shiki's. Strip them — our `code` component already provides the
    // outer container.
    pre(props: { children?: React.ReactNode }) {
      return <>{props.children}</>;
    },
  };
}

/// Renders a single ` ```mermaid ` fence to an inline SVG diagram.
/// Re-renders when the source changes (live agent writes), shows the
/// raw source plus the parser message on a syntax error so a broken
/// diagram is debuggable rather than blank, and renders nothing while
/// the (lazy-loaded) mermaid bundle resolves on first use.
function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void renderMermaid(chart).then((res) => {
      if (cancelled) return;
      if (res.error !== null) {
        setSvg(null);
        setError(res.error);
      } else {
        setSvg(res.svg);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (error) {
    return (
      <div className="my-3 overflow-x-auto rounded border border-red-900/60 bg-red-950/40 p-3 text-xs">
        <div className="mb-2 text-red-300">Invalid mermaid diagram: {error}</div>
        <pre className="text-neutral-400">
          <code>{chart}</code>
        </pre>
      </div>
    );
  }
  if (!svg) return null;
  return (
    <div
      className="mermaid-diagram my-3 flex justify-center overflow-x-auto rounded border border-neutral-800 bg-neutral-900/40 p-3 [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/// Same detection as `inferLanguage` uses for Markdown, pulled out so the
/// Preview tab can gate on the file extension without round-tripping
/// through Monaco's language service.
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx");
}
