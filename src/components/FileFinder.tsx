/// VS Code-style "Go to file" picker. Cmd+P opens; type to fuzzy-
/// match against the worktree's file list; Enter opens in the
/// editor; Esc closes. Result rows highlight the matched chars so
/// the user can see WHY a row matched.
///
/// Uses a single fuzzy matcher in `lib/fuzzy.ts` (no extra dep) and
/// caches the file list per-worktree on the store, refreshing the
/// next time the picker opens after a `diff_updated` event for the
/// active worktree (so adding/removing files doesn't require a
/// manual refresh).

import { useEffect, useMemo, useRef, useState } from "react";
import { listFiles, onDiffUpdated } from "@/ipc/client";
import type { WorktreeId } from "@/ipc/types";
import { fuzzyFilter } from "@/lib/fuzzy";
import { useDiffsStore } from "@/stores/diffs";
import { cn } from "@/lib/cn";

const MAX_RESULTS = 100;

export function FileFinder({
  worktreeId,
  open,
  onClose,
}: {
  worktreeId: WorktreeId;
  open: boolean;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const setView = useDiffsStore((s) => s.setView);
  const selectFile = useDiffsStore((s) => s.selectFile);
  const setPendingReveal = useDiffsStore((s) => s.setPendingReveal);
  // Marks the cached list as stale on `diff_updated`; we refetch on
  // the next open. Avoids re-walking on every fs event.
  const dirty = useRef(false);

  useEffect(() => {
    let cancelled = false;
    onDiffUpdated(worktreeId, () => {
      dirty.current = true;
    }).then((fn) => {
      if (cancelled) fn();
    });
    return () => {
      cancelled = true;
    };
  }, [worktreeId]);

  // Fetch on first open after a worktree change OR after the list
  // was marked dirty. Keep the previous list visible while the
  // refresh runs so the modal isn't blank.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    inputRef.current?.focus();
    if (files !== null && !dirty.current) return;
    let cancelled = false;
    void listFiles(worktreeId).then((list) => {
      if (cancelled) return;
      setFiles(list);
      dirty.current = false;
    });
    return () => {
      cancelled = true;
    };
  }, [open, worktreeId, files]);

  // Reset the cached list when the user switches to a different
  // worktree — the previous list isn't relevant.
  useEffect(() => {
    setFiles(null);
    dirty.current = false;
  }, [worktreeId]);

  const results = useMemo(() => {
    if (files === null) return [];
    return fuzzyFilter(files, query, (s) => s, MAX_RESULTS);
  }, [files, query]);

  // Keep `activeIdx` in range whenever the result set shrinks (e.g.
  // user typed another character that filtered things out).
  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(0);
  }, [results.length, activeIdx]);

  // Scroll the active row into view after each navigation.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector(`[data-idx="${activeIdx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  function open_(path: string) {
    setView(worktreeId, "file");
    selectFile(worktreeId, path);
    setPendingReveal(worktreeId, null);
    onClose();
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[activeIdx];
      if (r) open_(r.item);
    }
  }

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[90vw] overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={
            files === null
              ? "Loading file list…"
              : `Go to file… (${files.length} files)`
          }
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="w-full border-b border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
        />
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 && (
            <div className="px-3 py-4 text-center text-[11px] text-neutral-500">
              {files === null
                ? "Loading…"
                : query
                  ? "No matches"
                  : "Start typing to search"}
            </div>
          )}
          {results.map((r, i) => (
            <button
              key={r.item}
              data-idx={i}
              onMouseDown={(e) => {
                // Use mousedown so the click fires before the input's
                // blur — which would otherwise close the modal first
                // and swallow the click.
                e.preventDefault();
                open_(r.item);
              }}
              onMouseEnter={() => setActiveIdx(i)}
              className={cn(
                "block w-full truncate px-3 py-1 text-left font-mono text-[11px]",
                i === activeIdx
                  ? "bg-blue-950/40 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-950",
              )}
            >
              <Highlighted text={r.item} matches={r.matches} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Highlighted({ text, matches }: { text: string; matches: number[] }) {
  if (matches.length === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  const matchSet = new Set(matches);
  let buf = "";
  let inMatch = false;
  for (let i = 0; i < text.length; i++) {
    const isMatch = matchSet.has(i);
    if (isMatch !== inMatch && buf.length > 0) {
      out.push(
        inMatch ? (
          <span key={i + ":m"} className="font-semibold text-blue-300">
            {buf}
          </span>
        ) : (
          <span key={i + ":t"}>{buf}</span>
        ),
      );
      buf = "";
    }
    inMatch = isMatch;
    buf += text[i];
  }
  if (buf.length > 0) {
    out.push(
      inMatch ? (
        <span key="last:m" className="font-semibold text-blue-300">
          {buf}
        </span>
      ) : (
        <span key="last:t">{buf}</span>
      ),
    );
  }
  return <>{out}</>;
}
