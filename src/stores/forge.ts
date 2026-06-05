import { create } from "zustand";
import * as ipc from "@/ipc/client";
import type {
  ForgeStatus,
  ForgeIssue,
  ForgeMr,
  ForgePipeline,
  ForgeThread,
  ForgeApproval,
  ReviewCommentInput,
  WorkspaceId,
} from "@/ipc/types";
import { asMessage } from "@/lib/errors";
import { toastError } from "@/stores/toasts";

type IssueState = "open" | "closed" | "all";

/// Cache key for branch-scoped data (MRs, pipelines). Worktree IDs are
/// ephemeral across restarts, so we key on (workspaceId, branch) like the
/// comments store keys on (workspaceRoot, branch).
function bkey(workspaceId: WorkspaceId, branch: string): string {
  return `${workspaceId}::${branch}`;
}

type ForgeState = {
  /// Per-workspace CLI availability/auth. Loaded lazily; drives the auth banner.
  status: Record<string, ForgeStatus | undefined>;
  /// Issue browser state (single active workspace at a time — the modal scopes it).
  issues: ForgeIssue[];
  issuesLoading: boolean;
  /// Linked MR per (workspace, branch). `null` = looked up, none found.
  mrByBranch: Record<string, ForgeMr | null | undefined>;
  /// Pipelines per (workspace, branch), newest first.
  pipelinesByBranch: Record<string, ForgePipeline[] | undefined>;
  /// Review threads per MR iid (keyed by `${workspaceId}::mr::${iid}`).
  threadsByMr: Record<string, ForgeThread[] | undefined>;
  /// Current user's approval state per MR (keyed `${workspaceId}::mr::${iid}`).
  approvalByMr: Record<string, ForgeApproval | undefined>;

  loadStatus: (workspaceId: WorkspaceId) => Promise<void>;
  loadIssues: (
    workspaceId: WorkspaceId,
    query: string,
    stateFilter: IssueState,
  ) => Promise<void>;
  findMr: (workspaceId: WorkspaceId, branch: string) => Promise<ForgeMr | null>;
  createMr: (
    workspaceId: WorkspaceId,
    branch: string,
    title: string,
    body: string | null,
    draft: boolean,
  ) => Promise<ForgeMr | null>;
  loadApproval: (workspaceId: WorkspaceId, iid: number) => Promise<void>;
  approveMr: (workspaceId: WorkspaceId, iid: number) => Promise<boolean>;
  unapproveMr: (workspaceId: WorkspaceId, iid: number) => Promise<boolean>;
  mergeMr: (
    workspaceId: WorkspaceId,
    branch: string,
    iid: number,
  ) => Promise<boolean>;
  /// Post a general (non-line) MR comment, then reload threads.
  postMrComment: (
    workspaceId: WorkspaceId,
    iid: number,
    body: string,
  ) => Promise<boolean>;
  postReviewComments: (
    workspaceId: WorkspaceId,
    iid: number,
    comments: ReviewCommentInput[],
  ) => Promise<boolean>;
  loadThreads: (workspaceId: WorkspaceId, iid: number) => Promise<void>;
  replyThread: (
    workspaceId: WorkspaceId,
    iid: number,
    discussionId: string,
    body: string,
  ) => Promise<boolean>;
  resolveThread: (
    workspaceId: WorkspaceId,
    iid: number,
    discussionId: string,
    resolved: boolean,
  ) => Promise<boolean>;
  loadPipelines: (workspaceId: WorkspaceId, branch: string) => Promise<void>;
  retryPipeline: (
    workspaceId: WorkspaceId,
    branch: string,
    pipelineId: number,
  ) => Promise<void>;
};

export const useForgeStore = create<ForgeState>((set, get) => ({
  status: {},
  issues: [],
  issuesLoading: false,
  mrByBranch: {},
  pipelinesByBranch: {},
  threadsByMr: {},
  approvalByMr: {},

  async loadStatus(workspaceId) {
    try {
      const s = await ipc.forgeStatus(workspaceId);
      set((st) => ({ status: { ...st.status, [workspaceId]: s } }));
    } catch (e) {
      // Status is best-effort; a failure just leaves the banner hidden.
      console.warn("forge status failed", asMessage(e));
    }
  },

  async loadIssues(workspaceId, query, stateFilter) {
    set({ issuesLoading: true });
    try {
      const issues = await ipc.forgeListIssues(workspaceId, query, stateFilter, 50);
      set({ issues, issuesLoading: false });
    } catch (e) {
      set({ issuesLoading: false });
      toastError("Couldn't load issues", asMessage(e));
    }
  },

  async findMr(workspaceId, branch) {
    try {
      const mr = await ipc.forgeFindMrForBranch(workspaceId, branch);
      set((st) => ({ mrByBranch: { ...st.mrByBranch, [bkey(workspaceId, branch)]: mr } }));
      return mr;
    } catch (e) {
      console.warn("find MR failed", asMessage(e));
      return null;
    }
  },

  async createMr(workspaceId, branch, title, body, draft) {
    try {
      const mr = await ipc.forgeCreateMr(workspaceId, branch, title, body, draft);
      set((st) => ({ mrByBranch: { ...st.mrByBranch, [bkey(workspaceId, branch)]: mr } }));
      return mr;
    } catch (e) {
      toastError("Couldn't create MR", asMessage(e));
      return null;
    }
  },

  async loadApproval(workspaceId, iid) {
    try {
      const a = await ipc.forgeMrApproval(workspaceId, iid);
      set((st) => ({
        approvalByMr: { ...st.approvalByMr, [`${workspaceId}::mr::${iid}`]: a },
      }));
    } catch (e) {
      // Approvals may be unavailable (e.g. project tier); leave undefined so
      // the UI falls back to a plain Approve button.
      console.warn("load approval failed", asMessage(e));
    }
  },

  async approveMr(workspaceId, iid) {
    try {
      await ipc.forgeApproveMr(workspaceId, iid);
      await get().loadApproval(workspaceId, iid);
      return true;
    } catch (e) {
      toastError("Couldn't approve MR", asMessage(e));
      return false;
    }
  },

  async unapproveMr(workspaceId, iid) {
    try {
      await ipc.forgeUnapproveMr(workspaceId, iid);
      await get().loadApproval(workspaceId, iid);
      return true;
    } catch (e) {
      toastError("Couldn't revoke approval", asMessage(e));
      return false;
    }
  },

  async mergeMr(workspaceId, branch, iid) {
    try {
      await ipc.forgeMergeMr(workspaceId, iid);
      await get().findMr(workspaceId, branch);
      return true;
    } catch (e) {
      toastError("Couldn't merge MR", asMessage(e));
      // Refresh so the merge-status blocker chip reflects the current reason.
      await get().findMr(workspaceId, branch);
      return false;
    }
  },

  async postMrComment(workspaceId, iid, body) {
    try {
      await ipc.forgePostMrComment(workspaceId, iid, body);
      await get().loadThreads(workspaceId, iid);
      return true;
    } catch (e) {
      toastError("Couldn't post comment", asMessage(e));
      return false;
    }
  },

  async postReviewComments(workspaceId, iid, comments) {
    try {
      await ipc.forgePostReviewComments(workspaceId, iid, comments);
      return true;
    } catch (e) {
      toastError("Couldn't post review", asMessage(e));
      return false;
    }
  },

  async loadThreads(workspaceId, iid) {
    try {
      const threads = await ipc.forgeListThreads(workspaceId, iid);
      set((st) => ({
        threadsByMr: { ...st.threadsByMr, [`${workspaceId}::mr::${iid}`]: threads },
      }));
    } catch (e) {
      console.warn("load threads failed", asMessage(e));
    }
  },

  async replyThread(workspaceId, iid, discussionId, body) {
    try {
      await ipc.forgeReplyThread(workspaceId, iid, discussionId, body);
      await get().loadThreads(workspaceId, iid);
      return true;
    } catch (e) {
      toastError("Couldn't post reply", asMessage(e));
      return false;
    }
  },

  async resolveThread(workspaceId, iid, discussionId, resolved) {
    try {
      await ipc.forgeResolveThread(workspaceId, iid, discussionId, resolved);
      await get().loadThreads(workspaceId, iid);
      return true;
    } catch (e) {
      toastError(resolved ? "Couldn't resolve thread" : "Couldn't reopen thread", asMessage(e));
      return false;
    }
  },

  async loadPipelines(workspaceId, branch) {
    try {
      const pipelines = await ipc.forgeListPipelines(workspaceId, branch);
      set((st) => ({
        pipelinesByBranch: { ...st.pipelinesByBranch, [bkey(workspaceId, branch)]: pipelines },
      }));
    } catch (e) {
      console.warn("load pipelines failed", asMessage(e));
    }
  },

  async retryPipeline(workspaceId, branch, pipelineId) {
    try {
      await ipc.forgeRetryPipeline(workspaceId, pipelineId);
      await get().loadPipelines(workspaceId, branch);
    } catch (e) {
      toastError("Couldn't retry pipeline", asMessage(e));
    }
  },
}));

export { bkey as forgeBranchKey };
export type { IssueState as ForgeIssueState };
