/// Changes-pane base-ref picker — the GitHub/GitLab "base branch" selector.
/// Shows the ref the Branch-view diff compares against (the per-workspace
/// override, or `origin/<default>` by default) and lets the user pick another
/// branch from a searchable dropdown. The choice is persisted Rust-side, which
/// also recomputes every worktree's diff (arriving via `diff_updated`), so the
/// Changes list refreshes on its own.
///
/// Searchable list reuses the same `lib/fuzzy` matcher + keyboard model as the
/// Cmd+P FileFinder. The menu is portaled and viewport-fixed so the narrow,
/// resizable diff sidebar can't clip it.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listBranches } from "@/ipc/client";
import type { Workspace } from "@/ipc/types";
import { fuzzyFilter } from "@/lib/fuzzy";
import { useWorkspaceStore } from "@/stores/workspace";
import { cn } from "@/lib/cn";

const MENU_WIDTH = 288;

export function BaseRefPicker({ workspace }: { workspace: Workspace }) {
  const effective =
    workspace.baseRefOverride ?? `origin/${workspace.defaultBranch}`;
  const isOverridden = workspace.baseRefOverride != null;
  const setBaseRef = useWorkspaceStore((s) => s.setBaseRef);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.max(
        8,
        Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8),
      );
      setPos({ top: rect.bottom + 4, left });
    }
    setOpen(true);
  }

  // (Re)fetch the branch list each time the dropdown opens — cheap, and picks
  // up any branch fetched into the repo since it was last opened.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    inputRef.current?.focus();
    let cancelled = false;
    void listBranches(workspace.id).then((b) => {
      if (!cancelled) setBranches(b);
    });
    return () => {
      cancelled = true;
    };
  }, [open, workspace.id]);

  // Dismiss on click outside both the trigger and the portaled menu.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (
        !triggerRef.current?.contains(t) &&
        !panelRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const results = useMemo(() => {
    if (branches === null) return [];
    return fuzzyFilter(branches, query, (s) => s, 200);
  }, [branches, query]);

  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(0);
  }, [results.length, activeIdx]);

  useEffect(() => {
    const row = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  async function choose(ref: string | null) {
    setBusy(true);
    try {
      await setBaseRef(workspace.id, ref);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[activeIdx];
      if (r) void choose(r.item);
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="shrink-0 text-neutral-600">vs</span>
      <button
        ref={triggerRef}
        onClick={toggle}
        disabled={busy}
        title="Base ref the Branch-view diff compares against — i.e. what counts as 'your changes'. Applies to the whole repo."
        className={cn(
          "flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono normal-case tracking-normal transition hover:bg-neutral-800",
          isOverridden ? "text-amber-300" : "text-neutral-300",
        )}
      >
        <span className="truncate">{effective}</span>
        <span className="shrink-0 text-neutral-500">▾</span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
            className="fixed z-50 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 shadow-2xl"
          >
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder={
                branches === null ? "Loading branches…" : "Filter branches…"
              }
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              className="w-full border-b border-neutral-800 bg-neutral-950 px-2.5 py-1.5 font-mono text-[11px] text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
            />
            <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
              {isOverridden && (
                <button
                  onMouseDown={(e) => {
                    // mousedown (not click) so it fires before the input blur.
                    e.preventDefault();
                    void choose(null);
                  }}
                  className="block w-full truncate px-2.5 py-1 text-left font-mono text-[11px] text-neutral-400 hover:bg-neutral-950"
                >
                  ↺ Reset to default (origin/{workspace.defaultBranch})
                </button>
              )}
              {results.length === 0 && (
                <div className="px-2.5 py-3 text-center text-[11px] text-neutral-500">
                  {branches === null ? "Loading…" : "No matching branches"}
                </div>
              )}
              {results.map((r, i) => {
                const isCurrent = r.item === effective;
                return (
                  <button
                    key={r.item}
                    data-idx={i}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void choose(r.item);
                    }}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={cn(
                      "block w-full truncate px-2.5 py-1 text-left font-mono text-[11px]",
                      i === activeIdx
                        ? "bg-blue-950/40 text-neutral-100"
                        : "text-neutral-400 hover:bg-neutral-950",
                      isCurrent && "text-amber-300",
                    )}
                  >
                    {isCurrent ? "● " : ""}
                    {r.item}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
