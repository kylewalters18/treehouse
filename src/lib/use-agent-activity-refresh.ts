import { useEffect, useRef } from "react";

import { onAgentActivityChanged } from "@/ipc/client";

/// Run `refresh` now, whenever Rust reports an agent activity change
/// (`agents://activity-changed`), and every `fallbackMs` — the poll covers
/// the few changes that come with time rather than an event (relative
/// times, an answered Claude prompt expiring). `deps` restart it;
/// `enabled: false` stops it.
export function useAgentActivityRefresh(
  refresh: () => void,
  fallbackMs: number,
  enabled: boolean,
  deps: readonly unknown[] = [],
): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const run = () => {
      if (live) latest.current();
    };
    run();
    const timer = window.setInterval(run, fallbackMs);
    let unlisten: (() => void) | null = null;
    onAgentActivityChanged(run)
      .then((u) => {
        if (live) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      live = false;
      window.clearInterval(timer);
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fallbackMs, ...deps]);
}
