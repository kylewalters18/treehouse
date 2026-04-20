import { useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import { useUiStore } from "@/stores/ui";
import { mergeWorktree, onWorktreesChanged } from "@/ipc/client";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import type { Worktree } from "@/ipc/types";
import { cn } from "@/lib/cn";

export function WorktreeSidebar() {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const creating = useWorktreesStore((s) => s.creating);
  const error = useWorktreesStore((s) => s.error);
  const refresh = useWorktreesStore((s) => s.refresh);
  const createWt = useWorktreesStore((s) => s.create);
  const removeWt = useWorktreesStore((s) => s.remove);
  const selectedId = useUiStore((s) => s.selectedWorktreeId);
  const selectWorktree = useUiStore((s) => s.selectWorktree);

  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!workspace) return;
    refresh(workspace.id);
    const unlistenPromise = onWorktreesChanged(workspace.id, () =>
      refresh(workspace.id),
    );
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [workspace, refresh]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace || !name.trim() || creating) return;
    const wt = await createWt(workspace.id, name.trim());
    if (wt) {
      setName("");
      inputRef.current?.focus();
      selectWorktree(wt.id);
    }
  }

  async function onRemove(w: Worktree) {
    const ok = window.confirm(
      `Remove worktree "${w.branch}"?\n\n${w.path}\n\nThis will delete the checkout and local branch.`,
    );
    if (!ok) return;
    await removeWt(w.id, true);
  }

  async function onMerge(w: Worktree) {
    const ok = window.confirm(
      `Merge "${w.branch}" into the default branch?\n\nThis runs \`git merge --no-ff ${w.branch}\` on the main repo.`,
    );
    if (!ok) return;
    try {
      const result = await mergeWorktree(w.id);
      if (result.kind === "clean") {
        toastSuccess(`Merged ${w.branch}`, "Merge-back completed cleanly.");
      } else if (result.kind === "nothingToMerge") {
        toastInfo(
          `Nothing to merge on ${w.branch}`,
          result.uncommittedChanges
            ? "The agent's workdir has uncommitted changes. Commit them in the worktree (e.g. via the agent or the terminal), then merge again."
            : "The branch has no commits beyond the default branch.",
        );
      } else if (result.kind === "conflict") {
        toastError(
          `Conflicts merging ${w.branch}`,
          `${result.message}\n\nResolve in the main repo and commit.`,
        );
      } else if (result.kind === "wrongBranch") {
        toastInfo(
          "Wrong branch",
          `Main repo is on '${result.current}'. Check out '${result.expected}' there first.`,
        );
      }
    } catch (e: unknown) {
      const msg = e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e);
      toastError("Merge failed", msg);
    }
  }

  return (
    <div className="flex h-full flex-col border-r border-neutral-800">
      <div className="flex items-center justify-between border-b border-neutral-900 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          Worktrees
        </span>
        <span className="text-[11px] text-neutral-600">{worktrees.length}</span>
      </div>

      <form
        onSubmit={onCreate}
        className="flex gap-2 border-b border-neutral-900 p-3"
      >
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new worktree name"
          className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none"
          disabled={!workspace || creating}
        />
        <button
          type="submit"
          disabled={!workspace || !name.trim() || creating}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {creating ? "…" : "+"}
        </button>
      </form>

      {error && (
        <div className="m-3 rounded border border-red-900/60 bg-red-950/40 px-2 py-1 text-[11px] text-red-300">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {worktrees.length === 0 ? (
          <div className="m-3 rounded border border-dashed border-neutral-800 p-3 text-center text-[11px] text-neutral-600">
            No worktrees yet. Create one above.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-900">
            {worktrees.map((w) => (
              <li
                key={w.id}
                className={cn(
                  "group flex cursor-pointer items-start justify-between gap-2 px-3 py-2 hover:bg-neutral-900/50",
                  selectedId === w.id && "bg-neutral-900",
                )}
                onClick={() => selectWorktree(w.id)}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-neutral-200">
                    {w.branch}
                  </div>
                  <div
                    className="truncate font-mono text-[10px] text-neutral-500"
                    title={w.path}
                  >
                    {shortenPath(w.path)}
                  </div>
                </div>
                <span className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onMerge(w);
                    }}
                    className="rounded border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-emerald-800 hover:text-emerald-300"
                    title="Merge into default branch"
                  >
                    Merge
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(w);
                    }}
                    className="text-[11px] text-neutral-500 hover:text-red-400"
                    title="Remove worktree"
                  >
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  return parts.slice(-2).join("/");
}
