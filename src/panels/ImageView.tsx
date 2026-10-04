import { useEffect, useState } from "react";
import { readFileBytes } from "@/ipc/client";
import type { WorktreeId } from "@/ipc/types";
import { asMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";
import { imageMime } from "./markdown-plugins";

/// File-view renderer for raster images. Fits the pane by default; click
/// toggles 1:1 pixels (scrollable). Checkerboard shows transparency.
export function ImageView({
  worktreeId,
  path,
}: {
  worktreeId: WorktreeId;
  path: string;
}) {
  const [blob, setBlob] = useState<{ url: string; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [actualSize, setActualSize] = useState(false);

  useEffect(() => {
    setBlob(null);
    setError(null);
    setDims(null);
    setActualSize(false);
    let cancelled = false;
    let url: string | null = null;
    readFileBytes(worktreeId, path).then(
      (buf) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([buf], { type: imageMime(path) }));
        setBlob({ url, size: buf.byteLength });
      },
      (e) => {
        if (!cancelled) setError(asMessage(e));
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [worktreeId, path]);

  if (error) {
    return (
      <div className="m-3 rounded-md border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-300">
        {error}
      </div>
    );
  }
  if (!blob) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 text-xs text-neutral-500">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-neutral-950">
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto p-4",
          !actualSize && "flex items-center justify-center",
        )}
      >
        <img
          src={blob.url}
          alt={path}
          onLoad={(e) =>
            setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
          onError={() => setError("Couldn't decode image")}
          onClick={() => setActualSize((v) => !v)}
          title={actualSize ? "Click to fit" : "Click for actual size"}
          className={cn(
            "bg-[conic-gradient(#262626_25%,#171717_0_50%,#262626_0_75%,#171717_0)] bg-[length:16px_16px]",
            actualSize
              ? "max-w-none cursor-zoom-out"
              : "max-h-full max-w-full cursor-zoom-in object-contain",
          )}
          style={{ imageRendering: actualSize ? "pixelated" : "auto" }}
        />
      </div>
      <div className="flex shrink-0 gap-3 border-t border-neutral-800 px-3 py-1 text-[11px] text-neutral-500">
        {dims && (
          <span>
            {dims.w} × {dims.h}
          </span>
        )}
        <span>{(blob.size / 1024).toFixed(1)} KB</span>
        <span>{actualSize ? "100%" : "Fit"}</span>
      </div>
    </div>
  );
}
