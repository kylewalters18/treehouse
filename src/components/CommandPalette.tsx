/// VS Code-style command palette. Cmd+Shift+P opens; type to fuzzy-
/// match against an in-memory command registry; Enter runs; Esc closes.
/// Commands are computed at open time from current app state, so
/// context-sensitive entries (e.g. "Restart language servers" in the
/// active worktree) only appear when they're actually applicable.

import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyFilter } from "@/lib/fuzzy";
import { useUiStore } from "@/stores/ui";
import { useLspStore } from "@/stores/lsp";
import { disposeSessionsForWorktree } from "@/lsp/manager";
import {
  treehouseConfigOpenFile,
  treehouseConfigReload,
} from "@/ipc/client";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore, workspaceForWorktree } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import { toastInfo } from "@/stores/toasts";
import { cn } from "@/lib/cn";
import type { WorktreeId } from "@/ipc/types";

const MAX_RESULTS = 100;

type Command = {
  id: string;
  title: string;
  /// Optional grouping label rendered before the title in the menu and
  /// included in the fuzzy haystack so users can type the category to
  /// narrow (e.g. "lsp restart").
  category?: string;
  description?: string;
  run: () => void | Promise<void>;
};

function buildCommands(deps: {
  worktreeId: WorktreeId | null;
}): Command[] {
  const cmds: Command[] = [];
  if (deps.worktreeId) {
    const worktreeId = deps.worktreeId;
    cmds.push({
      id: "lsp.restart",
      category: "LSP",
      title: "Restart language servers",
      description:
        "Kill all running LSPs for this worktree and reopen the active file",
      run: async () => {
        await disposeSessionsForWorktree(worktreeId);
        // Re-fire `useLspIntegration` so the open file gets reattached
        // to a fresh server. Without this, dispose alone leaves the
        // model unbound and diagnostics never come back.
        useLspStore.getState().bumpRestartEpoch(worktreeId);
        toastInfo("Language servers restarted");
      },
    });
  }
  // Workspace-agnostic — always available so the user can read /
  // edit these from anywhere, including the main-clone view.
  cmds.push({
    id: "settings.edit",
    category: "Settings",
    title: "Edit",
    description:
      "Open treehouse.toml (LSP overrides, custom languages, worktree hooks, agent status patterns) in an in-app editor — Cmd+S saves",
    run: () => {
      useUiStore.getState().openSystemFileViewer("treehouseConfig");
    },
  });
  cmds.push({
    id: "settings.openExternally",
    category: "Settings",
    title: "Open externally",
    description:
      "Open treehouse.toml in your OS default .toml handler (VS Code, Sublime, etc.) instead of the in-app editor",
    run: async () => {
      await treehouseConfigOpenFile();
    },
  });
  cmds.push({
    id: "settings.reload",
    category: "Settings",
    title: "Reload",
    description:
      "Re-read treehouse.toml after editing; running agents pick up the new patterns on the next chunk",
    run: async () => {
      await treehouseConfigReload();
    },
  });
  cmds.push({
    id: "logs.view",
    category: "Logs",
    title: "View log",
    description:
      "Open the latest daily-rotated treehouse.log in an in-app viewer",
    run: () => {
      useUiStore.getState().openSystemFileViewer("log");
    },
  });
  cmds.push({
    id: "problems.toggle",
    category: "View",
    title: "Toggle Problems tab",
    description:
      "Flip the bottom pane between Terminal and Problems (Cmd+Shift+M)",
    run: () => {
      useUiStore.getState().toggleProblemsTab();
    },
  });
  cmds.push({
    id: "workspace.openAnother",
    category: "Workspace",
    title: "Open another repo",
    description:
      "Pick a folder and add it to the open set (your other repos stay open)",
    run: async () => {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Select a git repository to open",
      });
      if (typeof picked === "string") {
        await useWorkspaceStore.getState().openWorkspace(picked);
      }
    },
  });
  if (deps.worktreeId) {
    const selectedId = deps.worktreeId;
    const wt = useWorktreesStore
      .getState()
      .worktrees.find((w) => w.id === selectedId);
    const ws = workspaceForWorktree(wt?.workspaceId);
    if (ws) {
      cmds.push({
        id: "workspace.closeThis",
        category: "Workspace",
        title: `Close this repo (${ws.root.split("/").pop()})`,
        description:
          "Detach this repo from treehouse. Kills any live agents in it; worktree directories on disk are kept.",
        run: async () => {
          await useWorkspaceStore.getState().closeWorkspace(ws.id);
        },
      });
    }
  }
  return cmds;
}

function commandHaystack(c: Command): string {
  return `${c.category ?? ""} ${c.title}`.trim();
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const worktreeId = useUiStore((s) => s.selectedWorktreeId);

  // Recompute the command list each time the palette opens so context-
  // sensitive entries reflect the current worktree / active state.
  const commands = useMemo(
    () => buildCommands({ worktreeId }),
    // `open` deliberately included: rebuild on every open even if other
    // deps didn't change, in case downstream state (sessions, etc.) did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [worktreeId, open],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    inputRef.current?.focus();
  }, [open]);

  const results = useMemo(() => {
    return fuzzyFilter(commands, query, commandHaystack, MAX_RESULTS);
  }, [commands, query]);

  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(0);
  }, [results.length, activeIdx]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector(`[data-idx="${activeIdx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  async function run(cmd: Command) {
    onClose();
    try {
      await cmd.run();
    } catch (err) {
      console.error("command failed", cmd.id, err);
    }
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
      if (r) void run(r.item);
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
            commands.length === 0
              ? "No commands available"
              : `Run a command… (${commands.length})`
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
              {commands.length === 0
                ? "Open a worktree to see commands"
                : query
                  ? "No matches"
                  : "Start typing to search"}
            </div>
          )}
          {results.map((r, i) => (
            <button
              key={r.item.id}
              data-idx={i}
              onMouseDown={(e) => {
                // Use mousedown so the click fires before the input's
                // blur — which would otherwise close the palette first
                // and swallow the click.
                e.preventDefault();
                void run(r.item);
              }}
              onMouseEnter={() => setActiveIdx(i)}
              className={cn(
                "block w-full px-3 py-1.5 text-left transition-colors",
                i === activeIdx
                  ? "bg-blue-950/40 text-neutral-100"
                  : "text-neutral-300 hover:bg-neutral-950",
              )}
            >
              <div className="font-mono text-[11px]">
                {r.item.category && (
                  <span className="text-neutral-500">{r.item.category}: </span>
                )}
                <Highlighted
                  text={r.item.title}
                  haystackOffset={
                    r.item.category ? r.item.category.length + 1 : 0
                  }
                  matches={r.matches}
                />
              </div>
              {r.item.description && (
                <div className="mt-0.5 truncate text-[10px] text-neutral-500">
                  {r.item.description}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/// Same renderer pattern as FileFinder, but the fuzzy haystack is
/// `"<category> <title>"` while we render the title only — so we shift
/// match indices left by `haystackOffset` (the category prefix length).
/// Indices outside the title's range are dropped.
function Highlighted({
  text,
  haystackOffset,
  matches,
}: {
  text: string;
  haystackOffset: number;
  matches: number[];
}) {
  const titleMatches = matches
    .map((m) => m - haystackOffset)
    .filter((m) => m >= 0 && m < text.length);
  if (titleMatches.length === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  const matchSet = new Set(titleMatches);
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
