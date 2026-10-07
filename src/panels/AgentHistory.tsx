import { useEffect, useRef } from "react";

import type { AgentHistoryEntry } from "@/ipc/types";
import { cn } from "@/lib/cn";
import { formatWhen } from "@/lib/time";

/// Saved Claude / Kiro conversations for one worktree. Rendered as the header
/// button's dropdown and, trimmed to a few rows, in the empty agent pane.
export function AgentHistoryList({
  entries,
  onResume,
  onResumeAcp,
  onForget,
}: {
  entries: AgentHistoryEntry[];
  onResume: (entry: AgentHistoryEntry) => void;
  /// Reopen a Claude conversation in an ACP tab instead of a terminal.
  onResumeAcp?: (entry: AgentHistoryEntry) => void;
  /// Omitted in the empty-state card, which only resumes.
  onForget?: (entry: AgentHistoryEntry) => void;
}) {
  return (
    <div className="flex flex-col">
      {entries.map((e) => {
        const open = e.liveAgentId !== null;
        return (
          <div
            key={e.sessionId}
            role="button"
            tabIndex={0}
            onClick={() => onResume(e)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") onResume(e);
            }}
            title={open ? "Switch to the open tab" : "Resume this conversation"}
            className="group grid cursor-pointer grid-cols-[1fr_auto] items-center gap-x-2.5 border-t border-neutral-800/60 px-2.5 py-1.5 text-left hover:bg-neutral-800 focus:bg-neutral-800 focus:outline-none"
          >
            <div
              className={cn(
                "truncate text-xs",
                open ? "text-neutral-400" : "text-neutral-100",
              )}
            >
              {e.title ?? "Untitled conversation"}
            </div>
            <div className="row-span-2 flex items-center gap-2 text-[11px] tabular-nums text-neutral-500">
              {open && (
                <span className="rounded border border-neutral-700 px-1 text-[10px] text-neutral-400">
                  open
                </span>
              )}
              {onResumeAcp && !open && e.backend === "claudeCode" && (
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onResumeAcp(e);
                  }}
                  title="Resume in an ACP tab (structured transcript) instead of a terminal"
                  className="rounded border border-neutral-700 px-1 text-[10px] text-neutral-400 opacity-0 transition hover:border-blue-500 hover:text-blue-300 group-hover:opacity-100"
                >
                  ACP
                </button>
              )}
              <span>{formatWhen(e.lastActiveAt)}</span>
              {onForget && (
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onForget(e);
                  }}
                  title="Remove from history"
                  className="opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                >
                  ✕
                </button>
              )}
            </div>
            <div className="truncate text-[11px] text-neutral-500">
              {e.lastMessage ?? " "}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AgentHistoryMenu({
  worktreeName,
  entries,
  onResume,
  onResumeAcp,
  onForget,
  onClose,
}: {
  worktreeName: string;
  entries: AgentHistoryEntry[];
  onResume: (entry: AgentHistoryEntry) => void;
  onResumeAcp?: (entry: AgentHistoryEntry) => void;
  onForget: (entry: AgentHistoryEntry) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) {
      // The header button toggles the menu itself; ignore clicks on it
      // so they don't close-then-reopen.
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest("[data-agent-history-toggle]")) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-1 top-[30px] z-20 w-96 max-w-[calc(100%-0.5rem)] overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 shadow-2xl"
    >
      <div className="flex items-baseline justify-between gap-2 px-2.5 pb-1 pt-1.5 text-[11px] text-neutral-500">
        <span className="font-semibold text-neutral-300">Recent sessions</span>
        <span className="truncate font-mono">{worktreeName}</span>
      </div>
      {entries.length > 0 ? (
        <div className="max-h-80 overflow-y-auto">
          <AgentHistoryList
            entries={entries}
            onResume={onResume}
            onResumeAcp={onResumeAcp}
            onForget={onForget}
          />
        </div>
      ) : (
        <div className="border-t border-neutral-800/60 px-2.5 py-2 text-[11px] text-neutral-500">
          Nothing saved yet.
        </div>
      )}
      <div className="border-t border-neutral-800 px-2.5 py-1.5 text-[11px] text-neutral-500">
        Claude Code and Kiro conversations land here. Click one to resume.
      </div>
    </div>
  );
}

export function HistoryIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M2 2.5v2.8h2.8" />
      <path d="M8 5v3.2l2.2 1.4" />
    </svg>
  );
}
