/// What the ⌘J planner shows before a session is running: a prompt box that
/// starts one with that first message, and recent conversations to resume.

import { useEffect, useRef } from "react";

import type { AgentHistoryEntry } from "@/ipc/types";
import { formatWhen } from "@/lib/time";

const RECENT = 5;

export function PlannerLanding({
  repoName,
  draft,
  setDraft,
  history,
  onStart,
  onResume,
}: {
  /// Null for the global planner.
  repoName: string | null;
  draft: string;
  setDraft: (s: string) => void;
  history: AgentHistoryEntry[];
  onStart: (prompt?: string) => void;
  onResume: (entry: AgentHistoryEntry) => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => inputRef.current?.focus(), [repoName]);

  return (
    <div className="flex h-full justify-center overflow-y-auto bg-[#0F1114] px-6 pt-[8vh]">
      <div className="flex w-full max-w-[640px] flex-col gap-7 pb-10">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold text-neutral-100">
            {repoName ? `Plan in ${repoName}` : "Global planner"}
          </h1>
          <p className="text-[13px] text-neutral-400">
            {repoName
              ? "Brainstorm against the latest origin, then turn decisions into issues and worktrees."
              : "Not tied to a repo — names one per issue or worktree it creates."}
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onStart(draft.trim() || undefined);
          }}
          className="flex items-start gap-2.5 rounded-lg border border-neutral-700 bg-neutral-900 px-3.5 py-3 focus-within:border-neutral-500"
        >
          <span className="pt-px font-mono text-neutral-500">&gt;</span>
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            rows={Math.min(6, draft.split("\n").length)}
            placeholder="What are we planning?"
            aria-label="Start planning"
            className="flex-1 resize-none bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
          />
          <button
            type="submit"
            title={draft.trim() ? "Start with this message" : "Start an empty session"}
            className="font-mono text-[11px] text-neutral-500 hover:text-neutral-200"
          >
            ↵
          </button>
        </form>
        {history.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="px-3 pb-1 text-[11px] tracking-wide text-neutral-500">
              RECENT SESSIONS
            </div>
            {history.slice(0, RECENT).map((h) => (
              <button
                key={h.sessionId}
                onClick={() => onResume(h)}
                title="Resume this conversation"
                className="group flex items-center gap-3 rounded-md px-3 py-2 text-left text-[13px] hover:bg-neutral-800/60"
              >
                <span className="min-w-0 flex-1 truncate text-neutral-200">
                  {h.title ?? "Untitled session"}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {formatWhen(h.lastActiveAt)}
                </span>
                <span className="shrink-0 text-xs text-blue-400 opacity-0 group-hover:opacity-100">
                  Resume
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
