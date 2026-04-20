import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "@/stores/workspace";

export function Home() {
  const loading = useWorkspaceStore((s) => s.loading);
  const error = useWorkspaceStore((s) => s.error);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);

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

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex w-[28rem] flex-col items-center gap-6 rounded-2xl border border-neutral-800 bg-neutral-900 p-10 shadow-2xl">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
            agent-ide
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
      </div>
    </div>
  );
}
