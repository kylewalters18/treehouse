import { useMemo } from "react";
import { pasteAndSubmit } from "@/lib/agent";
import { useCommentsStore, formatBatchForAgent } from "@/stores/comments";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { useWorkspaceStore } from "@/stores/workspace";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import { asMessage } from "@/lib/errors";

/// Workspace-header pill that shows when one or more queued comments exist
/// for the currently-selected worktree. Click sends the batch to that
/// worktree's active agent and resolves the comments.
export function SendQueueButton() {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const selected = worktrees.find((w) => w.id === selectedWorktreeId) ?? null;
  const activeAgentId = useUiStore((s) =>
    selectedWorktreeId ? s.activeAgentByWorktree[selectedWorktreeId] ?? null : null,
  );
  const items = useCommentsStore((s) => s.items);
  const queue = useCommentsStore((s) => s.queue);
  const resolveComment = useCommentsStore((s) => s.resolve);

  // Queued comments scoped to the currently-selected worktree's branch.
  // Even if other branches have queued items, we only batch what's
  // relevant to the agent we're about to talk to.
  const queued = useMemo(() => {
    if (!workspace || !selected) return [];
    return items.filter(
      (c) =>
        queue.has(c.id) &&
        c.workspaceRoot === workspace.root &&
        c.branch === selected.branch &&
        c.resolvedAt === null,
    );
  }, [workspace, selected, items, queue]);

  if (queued.length === 0) return null;

  async function send() {
    if (!activeAgentId) {
      toastInfo("No active agent in this worktree");
      return;
    }
    try {
      await pasteAndSubmit(activeAgentId, formatBatchForAgent(queued));
      toastSuccess(
        `Sent ${queued.length} comment${queued.length === 1 ? "" : "s"}`,
        "Marking as resolved.",
      );
      // Resolve serially — sequential calls keep the persisted file in a
      // consistent shape (each resolve writes the whole list back).
      for (const c of queued) {
        await resolveComment(c.id);
      }
    } catch (e) {
      toastError("Couldn't send batch", asMessage(e));
    }
  }

  return (
    <button
      onClick={send}
      title={`Send ${queued.length} queued comment(s) to active agent`}
      className="rounded border border-blue-700 bg-blue-950/40 px-2 py-1 text-[11px] font-medium text-blue-200 hover:bg-blue-950/60"
    >
      Send queue ({queued.length})
    </button>
  );
}
