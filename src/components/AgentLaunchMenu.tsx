import { useEffect, useRef, useState } from "react";
import { Pencil, TerminalSquare } from "lucide-react";
import type { AgentBackendKind } from "@/ipc/types";
import { cn } from "@/lib/cn";
import {
  BACKENDS,
  BACKEND_NAMES,
  injectedTail,
  type LaunchProfile,
} from "@/lib/agent-profiles";
import { useUiStore } from "@/stores/ui";
import { BackendIcon } from "./BackendIcon";

const SCOPE_HEADINGS: Record<LaunchProfile["scope"], string> = {
  repo: "This repo",
  global: "All repos",
  default: "Defaults",
};

/// The agent pane's `▾` popover: pick a launch profile, or drop into
/// "Edit & launch" for a one-off command (optionally saved as a
/// repo-scoped profile). Keyboard: ↑/↓ + Enter to launch, Tab to edit the
/// highlighted profile's command, Esc to back out.
export function AgentLaunchMenu({
  profiles,
  defaultKey,
  workspaceName,
  onLaunch,
  onSaveProfile,
  onClose,
}: {
  profiles: LaunchProfile[];
  /// The profile `+` / ⌘⇧A would launch — marked in the list.
  defaultKey: string;
  workspaceName: string;
  onLaunch: (
    backend: AgentBackendKind,
    command: string,
    profileKey: string | null,
  ) => void;
  /// Persist a repo-scoped profile; resolves false when saving failed.
  onSaveProfile: (
    name: string,
    backend: AgentBackendKind,
    command: string,
  ) => Promise<boolean>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const commandRef = useRef<HTMLInputElement>(null);
  // Rows are the profiles plus a trailing "Edit & launch…" row.
  const editRow = profiles.length;
  const [highlight, setHighlight] = useState(() =>
    Math.max(0, profiles.findIndex((p) => p.key === defaultKey)),
  );
  const [editing, setEditing] = useState(false);
  const [backend, setBackend] = useState<AgentBackendKind>("claudeCode");
  const [command, setCommand] = useState("");
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest("[data-agent-launch-toggle]")) return;
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  useEffect(() => {
    if (editing) commandRef.current?.focus();
    else listRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (editing) return;
    listRef.current
      ?.querySelector(`[data-row="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, editing]);

  function startEditing(from: LaunchProfile | undefined) {
    const seed = from ?? profiles.find((p) => p.key === defaultKey);
    setBackend(seed?.backend ?? "claudeCode");
    setCommand(seed?.command ?? "");
    setSaveName("");
    setEditing(true);
  }

  function activate(i: number) {
    if (i === editRow) startEditing(undefined);
    else {
      const p = profiles[i];
      onLaunch(p.backend, p.command, p.key);
    }
  }

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(editRow, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(highlight);
    } else if (e.key === "Tab") {
      e.preventDefault();
      startEditing(profiles[highlight]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  async function saveAndLaunch() {
    const name = saveName.trim();
    if (!name || !command.trim() || saving) return;
    setSaving(true);
    const ok = await onSaveProfile(name, backend, command);
    setSaving(false);
    if (ok) onLaunch(backend, command, `repo:${name}`);
  }

  const tail = injectedTail(backend);

  return (
    <div
      ref={ref}
      className="absolute right-1 top-[30px] z-20 w-[26rem] max-w-[calc(100%-0.5rem)] overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 text-[11px] shadow-2xl"
    >
      {!editing ? (
        <div
          ref={listRef}
          tabIndex={-1}
          onKeyDown={onListKey}
          className="max-h-96 overflow-y-auto py-1 focus:outline-none"
        >
          {profiles.map((p, i) => (
            <div key={p.key}>
              {(i === 0 || profiles[i - 1].scope !== p.scope) && (
                <div
                  className={cn(
                    "flex items-baseline justify-between px-2.5 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500",
                    i > 0 && "mt-1 border-t border-neutral-800 pt-2",
                  )}
                >
                  <span>{SCOPE_HEADINGS[p.scope]}</span>
                  {p.scope === "repo" && (
                    <span className="truncate font-mono normal-case tracking-normal">
                      {workspaceName}
                    </span>
                  )}
                </div>
              )}
              <div
                data-row={i}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => activate(i)}
                className={cn(
                  "group mx-1 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1",
                  i === highlight ? "bg-neutral-800 text-neutral-100" : "text-neutral-300",
                )}
              >
                <BackendIcon backend={p.backend} />
                <span className="shrink-0 font-medium">{p.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-neutral-500">
                  {p.command}
                </span>
                {p.key === defaultKey && (
                  <kbd
                    title="What + and ⌘⇧A launch in this repo"
                    className="shrink-0 rounded border border-neutral-700 px-1 font-sans text-[10px] text-neutral-400"
                  >
                    ⌘⇧A
                  </kbd>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startEditing(p);
                  }}
                  title="Edit this command and launch once (Tab)"
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-500 opacity-0 hover:text-neutral-100 group-hover:opacity-100"
                >
                  <Pencil size={10} />
                </button>
              </div>
            </div>
          ))}
          <div className="mt-1 border-t border-neutral-800 pt-1">
            <div
              data-row={editRow}
              onMouseEnter={() => setHighlight(editRow)}
              onClick={() => activate(editRow)}
              className={cn(
                "mx-1 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1",
                highlight === editRow ? "bg-neutral-800 text-neutral-100" : "text-neutral-400",
              )}
            >
              <TerminalSquare size={12} className="shrink-0" />
              <span>Edit &amp; launch…</span>
            </div>
          </div>
          <div className="flex items-center justify-between px-2.5 pb-0.5 pt-1.5 text-[10px] text-neutral-600">
            <span>↑↓ pick · ⏎ launch · Tab edit</span>
            <button
              onClick={() => {
                onClose();
                useUiStore.getState().openSystemFileViewer("treehouseConfig");
              }}
              className="text-neutral-500 hover:text-neutral-300"
            >
              Profiles live in treehouse.toml
            </button>
          </div>
        </div>
      ) : (
        <div
          className="flex flex-col gap-2 p-2.5"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
        >
          <div className="flex items-center justify-between">
            <span className="font-semibold text-neutral-300">Edit &amp; launch</span>
            <div className="flex rounded-md border border-neutral-800 p-0.5">
              {BACKENDS.map((b) => (
                <button
                  key={b}
                  onClick={() => setBackend(b)}
                  title={BACKEND_NAMES[b]}
                  className={cn(
                    "flex items-center gap-1 rounded px-1.5 py-0.5",
                    b === backend
                      ? "bg-neutral-800 text-neutral-100"
                      : "text-neutral-500 hover:text-neutral-300",
                  )}
                >
                  <BackendIcon backend={b} size={11} />
                  {BACKEND_NAMES[b]}
                </button>
              ))}
            </div>
          </div>
          <div
            onClick={() => commandRef.current?.focus()}
            className="flex h-7 items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-950 px-2 font-mono text-[11px] focus-within:border-blue-500"
          >
            <span className="text-neutral-600">$</span>
            <input
              ref={commandRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onLaunch(backend, command, null);
                }
              }}
              placeholder={BACKEND_NAMES[backend] + " default command"}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="min-w-0 flex-1 bg-transparent text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
            />
            {tail && (
              <span
                title="Added by treehouse on every launch"
                className="shrink-0 select-none text-neutral-600"
              >
                + {tail}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveAndLaunch();
                }
              }}
              placeholder={`Profile name (saved to ${workspaceName})`}
              spellCheck={false}
              className="h-6 min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={() => void saveAndLaunch()}
              disabled={!saveName.trim() || !command.trim() || saving}
              className="h-6 shrink-0 rounded-md border border-neutral-700 px-2 text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save &amp; launch
            </button>
            <button
              onClick={() => onLaunch(backend, command, null)}
              className="h-6 shrink-0 rounded-md bg-blue-600 px-2 font-medium text-white hover:bg-blue-500"
            >
              Launch once
            </button>
          </div>
          <div className="text-[10px] text-neutral-600">
            ⏎ in the command launches once · Esc back to profiles
          </div>
        </div>
      )}
    </div>
  );
}
