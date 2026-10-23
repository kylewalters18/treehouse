import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { readFileBytes } from "@/ipc/client";
import type { WorktreeId } from "@/ipc/types";
import { asMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";

GlobalWorkerOptions.workerSrc = workerSrc;

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const PAGE_GAP = 16;
const PAD = 16;

/// File-view renderer for PDFs (pdf.js). Pages render lazily as they scroll
/// into view, each a canvas with a selectable text layer on top. Defaults to
/// fit-width; the status bar steps zoom.
export function PdfView({
  worktreeId,
  path,
}: {
  worktreeId: WorktreeId;
  path: string;
}) {
  const [doc, setDoc] = useState<{ pdf: PDFDocumentProxy; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Unscaled (scale 1) size of page 1 — placeholder size for unrendered pages
  // and the basis for fit-width.
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [width, setWidth] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDoc(null);
    setError(null);
    setBaseSize(null);
    setZoom("fit");
    setCurrentPage(1);
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    readFileBytes(worktreeId, path)
      .then(async (buf) => {
        if (cancelled) return;
        const size = buf.byteLength;
        const pdf = await getDocument({ data: new Uint8Array(buf) }).promise;
        loaded = pdf;
        if (cancelled) return void pdf.destroy();
        const vp = (await pdf.getPage(1)).getViewport({ scale: 1 });
        if (cancelled) return;
        setBaseSize({ w: vp.width, h: vp.height });
        setDoc({ pdf, size });
      })
      .catch((e) => {
        if (!cancelled) setError(asMessage(e));
      });
    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [worktreeId, path]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);

  const fitScale = baseSize && width > 0 ? (width - PAD * 2) / baseSize.w : 1;
  const scale = zoom === "fit" ? fitScale : zoom;

  const step = (dir: 1 | -1) => {
    const next =
      dir > 0
        ? ZOOM_STEPS.find((z) => z > scale + 0.001)
        : [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.001);
    if (next) setZoom(next);
  };

  // Current page = the last page whose top has scrolled past the pane's
  // upper third.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const mark = el.scrollTop + el.clientHeight / 3;
    let page = 1;
    for (const child of el.querySelectorAll<HTMLElement>("[data-page]")) {
      if (child.offsetTop > mark) break;
      page = Number(child.dataset.page);
    }
    setCurrentPage(page);
  };

  if (error) {
    return (
      <div className="m-3 rounded-md border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-300">
        {error}
      </div>
    );
  }
  if (!doc || !baseSize) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 text-xs text-neutral-500">
        Loading…
      </div>
    );
  }

  const pages = Array.from({ length: doc.pdf.numPages }, (_, i) => i + 1);
  return (
    <div className="flex h-full w-full flex-col bg-neutral-950">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto"
        style={{ padding: PAD }}
      >
        <div className="flex w-max min-w-full flex-col items-center" style={{ gap: PAGE_GAP }}>
          {width > 0 &&
            pages.map((n) => (
              <PdfPage
                key={n}
                pdf={doc.pdf}
                pageNumber={n}
                scale={scale}
                placeholder={baseSize}
                root={scrollRef.current}
              />
            ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-neutral-800 px-3 py-1 text-[11px] text-neutral-500">
        <span>
          Page {currentPage} / {doc.pdf.numPages}
        </span>
        <span>{(doc.size / 1024).toFixed(1)} KB</span>
        <span className="ml-auto flex items-center gap-1">
          <ZoomButton onClick={() => step(-1)} title="Zoom out">
            −
          </ZoomButton>
          <span className="w-10 text-center tabular-nums">{Math.round(scale * 100)}%</span>
          <ZoomButton onClick={() => step(1)} title="Zoom in">
            +
          </ZoomButton>
          <ZoomButton
            onClick={() => setZoom("fit")}
            title="Fit width"
            active={zoom === "fit"}
          >
            Fit
          </ZoomButton>
        </span>
      </div>
    </div>
  );
}

function ZoomButton({
  onClick,
  title,
  active,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "rounded px-1.5 hover:bg-neutral-800 hover:text-neutral-300",
        active && "text-neutral-300",
      )}
    >
      {children}
    </button>
  );
}

function PdfPage({
  pdf,
  pageNumber,
  scale,
  placeholder,
  root,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  placeholder: { w: number; h: number };
  root: HTMLElement | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState(placeholder);

  // Render once the page nears the viewport; keep it rendered afterwards so
  // scrolling back doesn't flash.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { root, rootMargin: "100% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [root, visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const unscaled = page.getViewport({ scale: 1 });
      setSize({ w: unscaled.width, h: unscaled.height });
      const canvas = canvasRef.current;
      const text = textRef.current;
      if (!canvas || !text) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      task = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      text.replaceChildren();
      textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: text,
        viewport,
      });
      await Promise.all([task.promise, textLayer.render()]);
    })().catch((e) => {
      // A zoom change mid-render cancels the stale task; anything else is real.
      if (!cancelled) console.warn(`pdf page ${pageNumber} render failed`, e);
    });
    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
    };
  }, [visible, pdf, pageNumber, scale]);

  return (
    <div
      ref={wrapRef}
      data-page={pageNumber}
      className="relative shrink-0 bg-white shadow-lg shadow-black/40"
      style={
        {
          width: size.w * scale,
          height: size.h * scale,
          "--scale-factor": scale,
        } as React.CSSProperties
      }
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div ref={textRef} className="textLayer" />
    </div>
  );
}
