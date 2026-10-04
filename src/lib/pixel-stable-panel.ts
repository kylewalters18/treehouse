import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";

/// Panel widths in px by key, shared across mounts (focus mode swaps
/// PanelGroups, which remounts both the sidebar and the diff pane).
/// A key is absent until first measured from the autosaved percentage.
const pxByKey = new Map<string, number>();

/// react-resizable-panels v2 sizes in percent, so a panel grows with its
/// group: focus mode widening the diff pane widened the explorer, and the
/// focus/normal layouts gave the worktree sidebar different widths. Pin a
/// panel to a pixel width instead: re-derive its percentage whenever the
/// group's box resizes (or `pin()` is called), and only take a new pixel
/// width from a handle drag. Collapsed panels are left alone.
///
/// `boxRef` is an element whose width matches the PanelGroup's.
export function usePixelStablePanel(
  key: string,
  boxRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<ImperativePanelHandle | null>,
  { minPct, maxPct = 100 }: { minPct: number; maxPct?: number },
) {
  const draggingRef = useRef(false);

  const pin = useCallback(() => {
    const box = boxRef.current;
    const panel = panelRef.current;
    if (!box || !panel || panel.isCollapsed()) return;
    const w = box.clientWidth;
    if (w <= 0) return;
    const px = pxByKey.get(key);
    if (px == null) {
      pxByKey.set(key, (panel.getSize() / 100) * w);
      return;
    }
    const pct = Math.min(maxPct, Math.max(minPct, (px / w) * 100));
    if (Math.abs(pct - panel.getSize()) > 0.1) panel.resize(pct);
  }, [key, boxRef, panelRef, minPct, maxPct]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => pin());
    ro.observe(el);
    return () => ro.disconnect();
  }, [boxRef, pin]);

  return {
    pin,
    onDragging: (dragging: boolean) => {
      draggingRef.current = dragging;
    },
    onResize: (size: number) => {
      // Dragging past minSize collapses to the rail — not a new width.
      const w = boxRef.current?.clientWidth ?? 0;
      if (draggingRef.current && w > 0 && size >= minPct) {
        pxByKey.set(key, (size / 100) * w);
      }
    },
  };
}
