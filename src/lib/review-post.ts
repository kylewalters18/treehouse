import type { Comment, ReviewCommentInput, WorkspaceId } from "@/ipc/types";
import { isFileLevel, shortSha } from "@/stores/comments";
import { useForgeStore } from "@/stores/forge";

/// How local review comments go up to an MR/PR. Line comments become inline
/// threads, anchored on a range's last line with the range spelled out in
/// the body (and on the base side for removed lines); whole-file comments
/// become general MR comments naming the file. Shared by the Review tab's
/// batch post and the comment box's single "Post to" so both post alike.
/// Comments on a single commit go up as general comments naming the commit:
/// an MR's inline positions are against its head, where those line numbers
/// no longer hold.
export function toForgePosts(comments: Comment[]): {
  inline: ReviewCommentInput[];
  general: string[];
} {
  return {
    inline: comments
      .filter((c) => !isFileLevel(c) && !c.commit)
      .map((c) => ({
        filePath: c.filePath,
        line: c.endLine ?? c.line,
        removed: c.side === "base",
        body:
          c.endLine !== null && c.endLine !== c.line
            ? `Lines ${c.line}–${c.endLine}:\n\n${c.text}`
            : c.text,
      })),
    general: comments
      .filter((c) => isFileLevel(c) || c.commit)
      .map((c) => `**${generalAnchor(c)}**\n\n${c.text}`),
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

/// Heading for a general MR comment: the file, plus the commit and lines
/// for a comment made on a single commit's diff.
function generalAnchor(c: Comment): string {
  if (!c.commit) return c.filePath;
  const sha = shortSha(c.commit);
  if (isFileLevel(c)) return `${c.filePath} @ ${sha}`;
  const lines =
    c.endLine !== null && c.endLine !== c.line ? `${c.line}–${c.endLine}` : `${c.line}`;
  return c.side === "base"
    ? `${c.filePath}:${lines} @ ${sha}^ (removed in ${sha})`
    : `${c.filePath}:${lines} @ ${sha}`;
}
