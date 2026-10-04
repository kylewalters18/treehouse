import type { Terminal } from "xterm";
import type { FitAddon } from "xterm-addon-fit";

/// fit() reflows the buffer and on a terminal with scrollback can leave
/// the viewport stranded near the top. Capture whether the user was
/// already pinned to the bottom and restore that after the reflow so
/// active panes stay glued to the latest output without yanking users
/// who have scrolled up to read history.
export function fitAndPin(fit: FitAddon, term: Terminal) {
  try {
    const buf = term.buffer.active;
    const wasAtBottom = buf.viewportY === buf.baseY;
    fit.fit();
    if (wasAtBottom) term.scrollToBottom();
  } catch {}
}

/// xterm caches its cell size from the first measurement and only
/// re-measures when `fontFamily` / `fontSize` options change. If the
/// first measurement ran against a fallback font (the real one was
/// still loading), every later fit() computes cols from the stale,
/// narrower cell and the grid overflows its host. There's no public
/// remeasure API, so reach into the char size service.
function remeasure(term: Terminal) {
  try {
    (
      term as unknown as {
        _core?: { _charSizeService?: { measure(): void } };
      }
    )._core?._charSizeService?.measure();
  } catch {}
}

/// Keep `term` fitted to `host`. A ResizeObserver alone misses cases
/// where the box is unchanged but the cell size moves under it:
///   - a web font finishing load after the first fit
///   - devicePixelRatio changes (window dragged across displays, zoom)
/// Both re-measure, then refit. Fits are skipped while the host is
/// detached (parked in a pool on worktree switch) — its box collapses
/// to 0 and fit() would push a degenerate size to the PTY.
export function watchFit(
  host: HTMLElement,
  fit: FitAddon,
  term: Terminal,
): { disconnect: () => void } {
  const refit = () => {
    if (!host.isConnected) return;
    fitAndPin(fit, term);
  };
  const remeasureAndRefit = () => {
    if (!host.isConnected) return;
    remeasure(term);
    fitAndPin(fit, term);
  };

  const ro = new ResizeObserver(refit);
  ro.observe(host);

  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  let disposed = false;
  fonts?.ready.then(() => {
    if (!disposed) remeasureAndRefit();
  });
  fonts?.addEventListener("loadingdone", remeasureAndRefit);

  // A `resolution` media query matches only the current DPR, so it
  // flips exactly once per change; re-arm against the new value.
  let mql: MediaQueryList | null = null;
  const onDpr = () => {
    remeasureAndRefit();
    armDpr();
  };
  const armDpr = () => {
    mql?.removeEventListener("change", onDpr);
    if (typeof window === "undefined" || !window.matchMedia) return;
    mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mql.addEventListener("change", onDpr);
  };
  armDpr();

  return {
    disconnect() {
      disposed = true;
      ro.disconnect();
      fonts?.removeEventListener("loadingdone", remeasureAndRefit);
      mql?.removeEventListener("change", onDpr);
    },
  };
}
