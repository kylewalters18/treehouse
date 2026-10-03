import type { WorkspaceId } from "@/ipc/types";

/// Which planner ⌘J shows: the current repo's (global when no repo), unless
/// the user picked another one by hand while in this same repo — that pick
/// sticks until they move to a different repo, so the popup never fights a
/// deliberate choice but also never strands them in a stale one. A pick of
/// a repo that's since been closed is ignored.
export function resolvePlannerScope(
  currentRepo: WorkspaceId | null,
  pick: { scope: WorkspaceId | null; forRepo: WorkspaceId | null } | null,
  openRepos: WorkspaceId[],
): WorkspaceId | null {
  if (pick && pick.forRepo === currentRepo && (pick.scope === null || openRepos.includes(pick.scope))) {
    return pick.scope;
  }
  return currentRepo;
}
