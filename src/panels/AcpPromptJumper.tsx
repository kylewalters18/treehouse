import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, CornerDownRight } from "lucide-react";

import { cn } from "@/lib/cn";

/// One sent prompt: its transcript index (the anchor to scroll to) and a
/// one-line label.
export type PromptEntry = { index: number; label: string };

/// The prompt as one line: its first non-blank line, else what it attached.
export function promptLabel(text: string, attachments: string[]): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line) return line;
  if (attachments.length > 0) return attachments.map((a) => a.split("/").pop()).join(", ");
  return "(empty prompt)";
}

/// Pinned over the top of the transcript once a prompt scrolls out of
/// view: the prompt whose turn is on screen. Click for every prompt,
/// newest first, filterable; picking one scrolls there.
export function AcpPromptJumper({
  prompts,
  current,
  onJump,
}: {
  prompts: PromptEntry[];
  /// Transcript index of the prompt being read.
  current: number;
  onJump: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const position = prompts.findIndex((p) => p.index === current);
  const entry = prompts[position];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return prompts
      .map((p, i) => ({ ...p, n: i + 1 }))
      .reverse()
      .filter((p) => !q || p.label.toLowerCase().includes(q));
  }, [prompts, query]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${highlight}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [highlight]);

  function toggle() {
    setOpen((o) => !o);
    setQuery("");
    // Start on the prompt being read.
    setHighlight(Math.max(0, prompts.length - 1 - position));
  }

  function pick(index: number) {
    setOpen(false);
    onJump(index);
  }

  if (!entry) return null;
  return (
    <div ref={ref} className="absolute inset-x-0 top-0 z-20 border-b border-neutral-800 bg-neutral-950/95 backdrop-blur-sm">
      <div className="relative mx-auto w-full max-w-3xl px-3">
        <button
          onClick={toggle}
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Jump to a prompt"
          className="flex h-7 w-full min-w-0 items-center gap-2 text-left text-[11.5px]"
        >
          <CornerDownRight size={12} className="shrink-0 text-neutral-500" />
          <span className="min-w-0 flex-1 truncate text-neutral-200">{entry.label}</span>
          <span className="shrink-0 tabular-nums text-neutral-500">
            {position + 1}/{prompts.length}
          </span>
          <ChevronDown
            size={12}
            className={cn("shrink-0 text-neutral-500 transition-transform", open && "rotate-180")}
          />
        </button>
        {open && (
          <div className="absolute inset-x-2 top-full z-30 mt-1 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 shadow-xl shadow-black/40">
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const d = e.key === "ArrowDown" ? 1 : -1;
                  if (shown.length) setHighlight((h) => (h + d + shown.length) % shown.length);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const row = shown[highlight];
                  if (row) pick(row.index);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
              placeholder="Filter prompts"
              spellCheck={false}
              className="w-full border-b border-neutral-800 bg-transparent px-2.5 py-1.5 text-[12px] text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
            />
            <div ref={listRef} role="listbox" aria-label="Prompts" className="max-h-72 overflow-y-auto py-1">
              {shown.length === 0 && (
                <div className="px-2.5 py-1.5 text-[11.5px] text-neutral-500">No matching prompts</div>
              )}
              {shown.map((p, i) => (
                <button
                  key={p.index}
                  data-row={i}
                  role="option"
                  aria-selected={p.index === current}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(p.index)}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left text-[12px]",
                    i === highlight ? "bg-neutral-800 text-neutral-100" : "text-neutral-300",
                  )}
                >
                  <span className="w-5 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-neutral-500">
                    {p.n}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{p.label}</span>
                  {p.index === current && <span className="shrink-0 text-[10.5px] text-neutral-500">here</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
