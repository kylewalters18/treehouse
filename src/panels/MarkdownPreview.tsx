/// GitHub-flavored markdown preview for `.md` / `.mdx` files.
///
/// Uses `react-markdown` + `remark-gfm` so tables, task lists, strikethrough,
/// and autolinks all render. Code fences run through Shiki with the Dark+
/// theme so highlighted blocks match the editor's tokenization. Styled via
/// Tailwind's `prose` utilities (dark variant); code-block colors come
/// straight from Shiki so the `prose` defaults don't fight the highlight.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const [expanded, setExpanded] = useState(false);

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
    <>
      {/* Inline preview is fit-to-width; click to read a complex diagram
          full-size in the pan/zoom lightbox. */}
      <button
        type="button"
        title="Click to zoom"
        onClick={() => setExpanded(true)}
        className="mermaid-diagram my-3 flex w-full cursor-zoom-in justify-center overflow-x-auto rounded border border-neutral-800 bg-neutral-900/40 p-3 transition-colors hover:border-neutral-700 [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {expanded && <MermaidLightbox svg={svg} onClose={() => setExpanded(false)} />}
    </>
  );
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 16;

type View = { scale: number; tx: number; ty: number };

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/// Full-window overlay that renders the diagram SVG with wheel-to-zoom
/// (anchored at the cursor) and drag-to-pan. Esc or a backdrop click
/// closes it. No external pan/zoom dependency: a single CSS `transform`
/// on the content wrapper does the work. The whole transform lives in one
/// `View` so wheel updates stay a single pure updater (nested setState
/// updaters double-apply under StrictMode and broke cursor anchoring).
function MermaidLightbox({ svg, onClose }: { svg: string; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // Fit-to-viewport on open: measure the SVG at its natural size (the
  // content wrapper has no transform until `view` is set) and scale it to
  // fill ~90% of the overlay, centered.
  const fit = useCallback((): View => {
    const c = containerRef.current?.getBoundingClientRect();
    const el = contentRef.current?.getBoundingClientRect();
    if (!c || !el || el.width === 0 || el.height === 0) {
      return { scale: 1, tx: 0, ty: 0 };
    }
    const scale = clampScale(Math.min(c.width / el.width, c.height / el.height) * 0.9);
    return {
      scale,
      tx: (c.width - el.width * scale) / 2,
      ty: (c.height - el.height * scale) / 2,
    };
  }, []);

  useLayoutEffect(() => {
    setView(fit());
  }, [fit, svg]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Zoom toward the cursor: keep the diagram point under the pointer fixed
  // by solving the new translate from the old transform — all in one pure
  // updater so a double-invoked updater yields the same result.
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setView((v) => {
      if (!v) return v;
      const scale = clampScale(v.scale * Math.exp(-e.deltaY * 0.0015));
      const ratio = scale / v.scale;
      return {
        scale,
        tx: cx - (cx - v.tx) * ratio,
        ty: cy - (cy - v.ty) * ratio,
      };
    });
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    if (!view) return;
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    setView((v) => (v ? { ...v, tx: d.tx + dx, ty: d.ty + dy } : v));
  }
  function onPointerUp() {
    drag.current = null;
  }

  return (
    <div className="fixed inset-0 z-50 bg-neutral-950" onMouseDown={onClose}>
      <div
        ref={containerRef}
        className="absolute inset-0 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setView(fit())}
      >
        <div
          ref={contentRef}
          className="absolute left-0 top-0 origin-top-left [&_svg]:h-auto [&_svg]:max-w-none"
          style={
            view
              ? { transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }
              : { visibility: "hidden" }
          }
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-neutral-900/80 px-2 py-1 text-[11px] text-neutral-400">
        scroll to zoom · drag to pan · double-click to fit · Esc to close
      </div>
      <button
        type="button"
        onClick={onClose}
        className="absolute right-3 top-3 rounded border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
      >
        Close
      </button>
    </div>
  );
}

/// Same detection as `inferLanguage` uses for Markdown, pulled out so the
/// Preview tab can gate on the file extension without round-tripping
/// through Monaco's language service.
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx");
}
