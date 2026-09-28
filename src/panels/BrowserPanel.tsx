import { useEffect, useRef, useState } from "react";
import { ExternalLink, RotateCw, Smartphone } from "lucide-react";
import type { WorktreeId } from "@/ipc/types";
import {
  browserHide,
  browserReload,
  browserShow,
  onBrowserNavigated,
  openExternalUrl,
} from "@/ipc/client";
import { BROWSER_DEVICES, useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { iconButton } from "@/lib/pane-chrome";
import { normalizeBrowserUrl } from "@/lib/browser-url";
import { cn } from "@/lib/cn";

/// Bottom-pane "Browser" tab: a localhost preview per worktree, for
/// looking at the dev server the worktree runs.
///
/// The page lives in a native child webview (Rust `browser` module), not
/// an iframe, so it's a top-level document — COOP/COEP isolation,
/// service workers and cookies behave as in Safari. This component only
/// renders the chrome and an empty slot, and keeps the webview laid over
/// that slot. Each worktree has its own webview; switching worktrees
/// swaps which one is shown, so pages keep their state.
///
/// A native view always draws above the app's DOM, so the webview is
/// hidden while any full-window overlay (dialogs, palettes, the agent
/// board) is open.
export function BrowserPanel() {
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId);
  const url = useUiStore((s) =>
    selectedWorktreeId ? s.browserUrlByWorktree[selectedWorktreeId] : undefined,
  );
  const deviceId = useUiStore((s) => s.browserDevice);
  const device = deviceId ? BROWSER_DEVICES[deviceId] : null;
  // Whatever the webview covers: the whole slot, or the device screen.
  const targetRef = useRef<HTMLDivElement>(null);
  useBrowserPlacement(targetRef, selectedWorktreeId, url, device?.width ?? null);
  useBrowserSync();

  if (!selectedWorktreeId) {
    return <Empty>Select a worktree to preview its dev server.</Empty>;
  }

  return (
    <div className="flex h-full flex-col">
      <AddressBar key={selectedWorktreeId} worktreeId={selectedWorktreeId} url={url} />
      {!url ? (
        <div className="min-h-0 flex-1 bg-neutral-950">
          <Empty>
            Enter a URL or port (e.g. <code className="text-neutral-300">5173</code>),
            or ⌘-click a localhost link in a terminal.
          </Empty>
        </div>
      ) : device ? (
        <DeviceFrame device={device} screenRef={targetRef} />
      ) : (
        <div ref={targetRef} className="min-h-0 flex-1 bg-neutral-950" />
      )}
    </div>
  );
}

type BrowserDevice = (typeof BROWSER_DEVICES)[keyof typeof BROWSER_DEVICES];

/// Bezel around the emulated screen, in px.
const BEZEL = 10;
/// Room under the frame for the size caption.
const CAPTION = 22;
const PADDING = 12;

/// A phone-shaped frame, as large as fits the slot up to 1:1. The
/// webview covers `screenRef`; Rust zooms the page so its viewport is
/// exactly `device.width` CSS px however small the frame is drawn.
function DeviceFrame({
  device,
  screenRef,
}: {
  device: BrowserDevice;
  screenRef: React.RefObject<HTMLDivElement | null>;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSlot({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const availW = slot.width - 2 * (PADDING + BEZEL);
  const availH = slot.height - 2 * (PADDING + BEZEL) - CAPTION;
  const scale = Math.max(0, Math.min(1, availW / device.width, availH / device.height));

  return (
    <div
      ref={slotRef}
      className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden bg-neutral-950"
    >
      {scale > 0 && (
        <>
          <div
            className="rounded-[18px] border-neutral-800 bg-black"
            style={{ borderWidth: BEZEL }}
          >
            <div
              ref={screenRef}
              style={{ width: device.width * scale, height: device.height * scale }}
            />
          </div>
          <div
            className="flex items-end font-mono text-[10px] text-neutral-500"
            style={{ height: CAPTION }}
          >
            {device.label} · {device.width}×{device.height}
            {scale < 1 && ` · ${Math.round(scale * 100)}%`}
          </div>
        </>
      )}
    </div>
  );
}

/// Full-window overlays the native webview would otherwise draw over.
const OVERLAY_SELECTOR = ".fixed.inset-0";

/// Keep the selected worktree's webview on top of `targetRef`, or hidden.
///
/// Polls the slot's rect every frame rather than observing it: the slot
/// moves with panel drags, sidebar collapse, maximize, zoom and tab
/// switches (the tab hides via `display: none` → zero rect), and a
/// per-frame `getBoundingClientRect` is cheaper than chasing each one.
/// IPC only goes out when the placement actually changes.
function useBrowserPlacement(
  targetRef: React.RefObject<HTMLDivElement | null>,
  worktreeId: WorktreeId | null,
  url: string | undefined,
  deviceWidth: number | null,
) {
  // Only the URL a webview is *created* with comes from here; after
  // that, in-page navigation updates `url` and must not re-place it.
  const urlRef = useRef(url);
  urlRef.current = url;
  const hasUrl = !!url;

  useEffect(() => {
    let raf = 0;
    let last = "";
    // Serialize calls so a hide can't overtake the show before it.
    let queue: Promise<void> = Promise.resolve();
    const send = (call: () => Promise<void>) => {
      queue = queue.then(call).catch((e) => console.warn("[browser]", e));
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const r = targetRef.current?.getBoundingClientRect();
      const visible =
        worktreeId !== null &&
        hasUrl &&
        r !== undefined &&
        r.width > 0 &&
        r.height > 0 &&
        document.querySelector(OVERLAY_SELECTOR) === null;
      const key = visible
        ? `${worktreeId}|${r.x}|${r.y}|${r.width}|${r.height}|${window.innerWidth}|${deviceWidth}`
        : "hidden";
      if (key === last) return;
      last = key;
      if (visible) {
        const bounds = {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          viewportWidth: window.innerWidth,
          deviceWidth,
        };
        const createUrl = urlRef.current!;
        send(() => browserShow(worktreeId, createUrl, bounds));
      } else {
        send(() => browserHide());
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      send(() => browserHide());
    };
  }, [targetRef, worktreeId, hasUrl, deviceWidth]);
}

/// Mirror in-page navigation into the address bar, and close the
/// previews of worktrees that no longer exist.
function useBrowserSync() {
  const setBrowserUrl = useUiStore((s) => s.setBrowserUrl);
  const closeBrowser = useUiStore((s) => s.closeBrowser);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const urls = useUiStore((s) => s.browserUrlByWorktree);

  useEffect(() => {
    const p = onBrowserNavigated(({ worktreeId, url }) => {
      // Ignore stragglers from a preview that was just closed.
      if (useUiStore.getState().browserUrlByWorktree[worktreeId] !== undefined) {
        setBrowserUrl(worktreeId, url);
      }
    });
    return () => void p.then((unlisten) => unlisten());
  }, [setBrowserUrl]);

  useEffect(() => {
    const live = new Set(worktrees.map((w) => w.id));
    for (const id of Object.keys(urls) as WorktreeId[]) {
      if (!live.has(id)) closeBrowser(id);
    }
  }, [worktrees, urls, closeBrowser]);
}

function AddressBar({
  worktreeId,
  url,
}: {
  worktreeId: WorktreeId;
  url: string | undefined;
}) {
  const navigateBrowser = useUiStore((s) => s.navigateBrowser);
  const device = useUiStore((s) => s.browserDevice);
  const setDevice = useUiStore((s) => s.setBrowserDevice);
  const onReload = () => void browserReload(worktreeId).catch(() => {});
  const [draft, setDraft] = useState(url ?? "");
  // Follow external changes (⌘-click from a terminal) into the input.
  useEffect(() => setDraft(url ?? ""), [url]);

  function submit() {
    const next = normalizeBrowserUrl(draft);
    if (!next) return;
    setDraft(next);
    if (next === url) onReload();
    else navigateBrowser(worktreeId, next);
  }

  return (
    <div className="flex h-[30px] shrink-0 items-center gap-1 border-b border-neutral-800 bg-chrome px-2">
      <button
        className={iconButton}
        onClick={onReload}
        disabled={!url}
        title="Reload"
        aria-label="Reload"
      >
        <RotateCw size={13} />
      </button>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setDraft(url ?? "");
        }}
        onFocus={(e) => e.currentTarget.select()}
        placeholder="localhost:5173"
        spellCheck={false}
        className="h-6 min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 font-mono text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
      />
      <button
        className={cn(iconButton, device && "bg-neutral-800 text-blue-400")}
        onClick={() => setDevice(device ? null : "iphone-16-pro")}
        title={device ? "Fill the pane" : "View as iPhone 16 Pro (402×874)"}
        aria-label="Toggle iPhone 16 Pro view"
        aria-pressed={!!device}
      >
        <Smartphone size={13} />
      </button>
      <button
        className={iconButton}
        onClick={() => url && void openExternalUrl(url)}
        disabled={!url}
        title="Open in default browser"
        aria-label="Open in default browser"
      >
        <ExternalLink size={13} />
      </button>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-xs text-neutral-500">
      <p>{children}</p>
    </div>
  );
}
