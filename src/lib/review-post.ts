import type { Comment, ReviewCommentInput, WorkspaceId } from "@/ipc/types";
import { isFileLevel } from "@/stores/comments";
import { useForgeStore } from "@/stores/forge";

/// How local review comments go up to an MR/PR. Line comments become inline
/// threads, anchored on a range's last line with the range spelled out in
/// the body (and on the base side for removed lines); whole-file comments
/// become general MR comments naming the file. Shared by the Review tab's
/// batch post and the comment box's single "Post to" so both post alike.
export function toForgePosts(comments: Comment[]): {
  inline: ReviewCommentInput[];
  general: string[];
} {
  return {
    inline: comments
      .filter((c) => !isFileLevel(c))
      .map((c) => ({
        filePath: c.filePath,
        line: c.endLine ?? c.line,
        removed: c.side === "base",
        body:
          c.endLine !== null && c.endLine !== c.line
            ? `Lines ${c.line}–${c.endLine}:\n\n${c.text}`
            : c.text,
      })),
    general: comments.filter(isFileLevel).map((c) => `**${c.filePath}**\n\n${c.text}`),
  };
}

/// Post `comments` to MR/PR `iid`. Returns false (after the store toasts)
/// on the first failure. Threads are reloaded so the posted comments show
/// up as MR threads.
export async function postCommentsToMr(
  workspaceId: WorkspaceId,
  iid: number,
  comments: Comment[],
): Promise<boolean> {
  const { postReviewComments, postMrComment, loadThreads } = useForgeStore.getState();
  const { inline, general } = toForgePosts(comments);
  if (inline.length > 0 && !(await postReviewComments(workspaceId, iid, inline))) return false;
  for (const body of general) {
    if (!(await postMrComment(workspaceId, iid, body))) return false;
  }
  await loadThreads(workspaceId, iid);
  return true;
}
