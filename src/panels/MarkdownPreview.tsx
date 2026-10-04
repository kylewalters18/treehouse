/// GitHub-flavored markdown preview for `.md` / `.mdx` files.
///
/// `react-markdown` + `remark-gfm` for tables, task lists, footnotes and
/// autolinks; raw HTML (`<details>`, `<img align>`, …) goes through
/// `rehype-raw` and then `rehype-sanitize` — this webview can call Tauri
/// commands, so agent-written HTML must never run script. After
/// sanitizing, `rehype-slug` adds heading ids and `rehypeGithubAlerts`
/// turns `> [!NOTE]` blocks into callouts. Styling is our own
/// `.markdown-body` sheet in styles.css (GitHub-shaped, on the app's
/// color tokens); code fences run through Shiki with the editor theme.
/// Links and images resolve against the worktree like GitHub does.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import type { Highlighter } from "shiki";
import { onDiffUpdated, openExternalUrl, readFile, readFileBytes } from "@/ipc/client";
import type { FileContent, WorktreeId } from "@/ipc/types";
import { asMessage } from "@/lib/errors";
import { useDiffsStore } from "@/stores/diffs";
import { getMarkdownHighlighter, highlightCode } from "./markdown-shiki";
import { renderMermaid } from "./markdown-mermaid";
import {
  imageMime,
  rehypeGithubAlerts,
  resolveLink,
  resolveRelativePath,
} from "./markdown-plugins";
import {
  SUSPECT_RECHECK_MS,
  classifyDiskRead,
  createCoalescedRunner,
} from "./disk-sync";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeRaw, rehypeSanitize, rehypeSlug, rehypeGithubAlerts];
// Sanitize already prefixes ids with `user-content-`; without this,
// footnote ids get the prefix twice and their links break.
const REMARK_REHYPE_OPTIONS = { clobberPrefix: "" };

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
    // Text currently rendered, so a refresh that reads the same bytes
    // (or a transient mid-write empty/missing read) doesn't re-render.
    let shown: string | null = null;
    // Same pipeline as EditorPane's reload-on-disk: serialized +
    // coalesced reads (no stale out-of-order results), and a failed or
    // suddenly-empty read is re-checked before it replaces the preview.
    const runner = createCoalescedRunner(async (isStale) => {
      let confirmed = shown === null;
      for (;;) {
        let c: FileContent | null = null;
        let err: unknown = null;
        try {
          c = await readFile(worktreeId, path);
        } catch (e) {
          err = e;
        }
        if (cancelled || isStale()) return;
        const verdict = classifyDiskRead(
          c ? { ok: true, text: c.text } : { ok: false },
          shown ?? "",
          confirmed,
        );
        if (verdict.kind === "suspect") {
          await new Promise((r) => setTimeout(r, SUSPECT_RECHECK_MS));
          if (cancelled || isStale()) return;
          confirmed = true;
          continue;
        }
        if (verdict.kind === "echo" && shown !== null) return;
        if (c) {
          shown = c.text;
          setError(null);
          setContent(c);
        } else {
          setError(asMessage(err));
        }
        return;
      }
    });
    runner.trigger();

    // Live-refresh on agent writes. Keep reacting for one event after
    // the file leaves the diff so a revert-to-base still refreshes.
    let wasInDiff = true;
    let unlisten: (() => void) | null = null;
    onDiffUpdated(worktreeId, (diff) => {
      if (cancelled) return;
      const inDiff = diff.files.some((f) => f.path === path);
      const relevant = inDiff || wasInDiff;
      wasInDiff = inDiff;
      if (relevant) runner.trigger();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      runner.dispose();
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

  if (isMermaidPath(path)) {
    // A parse failure renders the error plus source, so a misidentified
    // `.mmd` (e.g. MultiMarkdown) is still readable here.
    return (
      <div className="h-full overflow-auto bg-neutral-950 px-8 py-6">
        <MermaidDiagram chart={content.text} />
      </div>
    );
  }

  return (
    <PreviewBody worktreeId={worktreeId} path={path} text={content.text} highlighter={highlighter} />
  );
}

function PreviewBody({
  worktreeId,
  path,
  text,
  highlighter,
}: {
  worktreeId: WorktreeId;
  path: string;
  text: string;
  highlighter: Highlighter | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToAnchor = useCallback((id: string) => {
    const root = scrollRef.current;
    if (!root || !id) return;
    // Heading slugs are unprefixed; raw-HTML `id`/`name` and footnotes
    // carry sanitize's `user-content-` prefix.
    const target =
      root.querySelector(`[id="${CSS.escape(id)}"]`) ??
      root.querySelector(`[id="user-content-${CSS.escape(id)}"]`) ??
      root.querySelector(`[name="user-content-${CSS.escape(id)}"]`);
    target?.scrollIntoView({ block: "start" });
  }, []);

  // A cross-file link (`other.md#section`) lands here once the target
  // file's content has rendered.
  useEffect(() => {
    if (pendingAnchor?.path === path) {
      scrollToAnchor(pendingAnchor.id);
      pendingAnchor = null;
    }
  }, [path, text, scrollToAnchor]);

  const components = useMemo(
    () => markdownComponents({ worktreeId, path, highlighter, scrollToAnchor }),
    [worktreeId, path, highlighter, scrollToAnchor],
  );

  return (
    <div ref={scrollRef} className="h-full overflow-auto bg-neutral-950 px-8 py-6">
      <article className="markdown-body mx-auto max-w-[52rem]">
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          remarkRehypeOptions={REMARK_REHYPE_OPTIONS}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </article>
    </div>
  );
}

/// react-markdown component overrides: Shiki / mermaid code fences,
/// worktree-aware links and images, and scrollable tables.
function markdownComponents({
  worktreeId,
  path,
  highlighter,
  scrollToAnchor,
}: {
  worktreeId: WorktreeId;
  path: string;
  highlighter: Highlighter | null;
  scrollToAnchor: (id: string) => void;
}): Components {
  return {
    code({ className, children }) {
      const match = /language-(\S+)/.exec(className ?? "");
      // Inline code (no language fence) — styled by `.markdown-body code`.
      if (!match) return <code>{children}</code>;
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
          <div className="shiki-block">
            <pre className="shiki">
              <code>{code}</code>
            </pre>
          </div>
        );
      }
      return (
        <div
          className="shiki-block"
          dangerouslySetInnerHTML={{ __html: highlightCode(highlighter, code, match[1]) }}
        />
      );
    },
    // `pre` wraps fenced `<code>`; our `code` component renders the
    // whole block (Shiki emits its own `<pre>`), so drop the wrapper.
    pre({ children }) {
      return <>{children}</>;
    },
    // Wide tables scroll inside the column instead of the whole pane.
    table({ children }) {
      return (
        <div className="table-wrap">
          <table>{children}</table>
        </div>
      );
    },
    a({ href, children, title, id }) {
      return (
        <a
          href={href}
          title={title}
          id={id}
          onClick={(e) => {
            // Never let the webview itself navigate away from the app.
            e.preventDefault();
            if (!href) return;
            followLink(worktreeId, path, href, scrollToAnchor);
          }}
        >
          {children}
        </a>
      );
    },
    img({ node, src, alt, title, width, height }) {
      // `align` isn't in React's img typings; read it off the hast node.
      const align = node?.properties?.align;
      return (
        <WorktreeImage
          worktreeId={worktreeId}
          fromPath={path}
          src={typeof src === "string" ? src : undefined}
          alt={alt}
          title={title}
          width={width}
          height={height}
          align={typeof align === "string" ? align : undefined}
        />
      );
    },
  };
}

/// Anchor to scroll to after a cross-file link switches the preview.
let pendingAnchor: { path: string; id: string } | null = null;

function followLink(
  worktreeId: WorktreeId,
  fromPath: string,
  href: string,
  scrollToAnchor: (id: string) => void,
) {
  const target = resolveLink(fromPath, href);
  switch (target.kind) {
    case "anchor":
      scrollToAnchor(target.id);
      return;
    case "external":
      void openExternalUrl(target.url);
      return;
    case "file": {
      if (target.path === fromPath) {
        if (target.anchor) scrollToAnchor(target.anchor);
        return;
      }
      const ds = useDiffsStore.getState();
      pendingAnchor = target.anchor ? { path: target.path, id: target.anchor } : null;
      ds.selectFile(worktreeId, target.path);
      // Markdown / mermaid stay in Preview; anything else opens in the editor.
      ds.setView(worktreeId, isPreviewablePath(target.path) ? "preview" : "file");
      return;
    }
    case "none":
      return;
  }
}

/// `<img>` that loads worktree-relative sources through IPC (the webview
/// has no file access) and passes http(s) sources straight through.
function WorktreeImage({
  worktreeId,
  fromPath,
  src,
  ...rest
}: {
  worktreeId: WorktreeId;
  fromPath: string;
  src: string | undefined;
  alt?: string;
  title?: string;
  width?: number | string;
  height?: number | string;
  align?: string;
}) {
  const remote = !!src && /^https?:\/\//i.test(src);
  const localPath = src && !remote ? resolveRelativePath(fromPath, src.split(/[?#]/)[0]) : null;
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setBlobUrl(null);
    setFailed(false);
    if (!localPath) return;
    let cancelled = false;
    let url: string | null = null;
    readFileBytes(worktreeId, localPath).then(
      (buf) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([buf], { type: imageMime(localPath) }));
        setBlobUrl(url);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [worktreeId, localPath]);

  if (remote) return <img src={src} {...rest} />;
  if (failed || (!localPath && src)) {
    return <span className="img-missing">{rest.alt || src}</span>;
  }
  if (!blobUrl) return null;
  return <img src={blobUrl} {...rest} />;
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

/// Standalone mermaid source (`mmdc`'s `.mmd`, GitHub's `.mermaid`).
export function isMermaidPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".mmd") || lower.endsWith(".mermaid");
}

/// Files with a rendered Preview tab: markdown and standalone mermaid.
export function isPreviewablePath(path: string): boolean {
  return isMarkdownPath(path) || isMermaidPath(path);
}
