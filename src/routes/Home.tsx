import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "@/stores/workspace";
import { listRecentWorkspaces } from "@/ipc/client";
import type { RecentWorkspace } from "@/ipc/types";

export function Home() {
  const loading = useWorkspaceStore((s) => s.loading);
  const error = useWorkspaceStore((s) => s.error);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);

  const [recent, setRecent] = useState<RecentWorkspace[]>([]);

  useEffect(() => {
    let cancelled = false;
    listRecentWorkspaces()
      .then((list) => {
        if (!cancelled) setRecent(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function pickRepo() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Select a git repository",
    });
    if (typeof picked === "string") {
      await openWorkspace(picked);
    }
  }

  async function openPath(path: string) {
    if (loading) return;
    await openWorkspace(path);
  }

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex w-[32rem] flex-col gap-6 rounded-2xl border border-neutral-800 bg-neutral-900 p-10 shadow-2xl">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
            treehouse
          </h1>
          <p className="mt-1 text-sm text-neutral-400">
            Parallel AI agents in git worktrees.
          </p>
        </div>
        <button
          onClick={pickRepo}
          disabled={loading}
          className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-500 disabled:opacity-60"
        >
          {loading ? "Opening…" : "Open repository"}
        </button>
        {error && (
          <div className="w-full rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        {recent.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="mb-1 text-[11px] uppercase tracking-wider text-neutral-500">
              Recent
            </div>
            <ul className="max-h-64 overflow-y-auto">
              {recent.map((r) => (
                <li key={r.path}>
                  <button
                    onClick={() => openPath(r.path)}
                    disabled={loading}
                    className="flex w-full items-center justify-between gap-2 rounded px-3 py-1.5 text-left hover:bg-neutral-800 disabled:opacity-60"
                    title={r.path}
                  >
                    <span className="min-w-0 flex-1">
                      <div className="truncate text-sm text-neutral-200">
                        {basename(r.path)}
                      </div>
                      <div className="truncate font-mono text-[11px] text-neutral-500">
                        {shortHome(r.path)}
                      </div>
                    </span>
                    <span className="shrink-0 text-[11px] text-neutral-600">
                      {formatWhen(Number(r.lastOpenedAt))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function shortHome(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

export function formatWhen(ms: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}
