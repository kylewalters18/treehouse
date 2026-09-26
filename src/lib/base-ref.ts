import type { Workspace } from "@/ipc/types";

/// The ref a workspace's branch diff compares against: the user's
/// override from the base-ref picker, else `origin/<default branch>`.
export function effectiveBaseRef(workspace: Workspace): string {
  return workspace.baseRefOverride ?? `origin/${workspace.defaultBranch}`;
}
