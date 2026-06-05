//! Forge integration — issues, merge/pull requests, review threads, and CI —
//! over the `glab`/`gh` CLIs. The Rust side stays the source of truth; the
//! renderer calls the `forge_*` commands in `ipc::commands`.
//!
//! `Forge` is a closed two-variant enum (static dispatch, no `async-trait`).
//! The GitLab provider is built/validated first; GitHub follows the same
//! method surface (see `github.rs`). Auto-detected per workspace from the git
//! remote; never let the CLI infer the host from cwd — we pass it explicitly.

pub mod cli;
pub mod github;
pub mod gitlab;
pub mod remote;
pub mod types;

use std::path::Path;

pub use remote::RemoteInfo;
pub use types::*;

use github::GithubForge;
use gitlab::GitlabForge;

use crate::util::errors::{AppError, AppResult};

/// Resolve the forge remote for a repo root: `git remote get-url origin`,
/// then parse. `Ok(None)` when there's no origin or we can't classify it.
pub async fn detect(repo_root: &Path) -> AppResult<Option<RemoteInfo>> {
    let url = crate::worktree::git_ops::remote_url(repo_root).await?;
    Ok(url.as_deref().and_then(remote::parse_remote))
}

/// Construct the provider for a recognized remote. Errors on `Unknown` kind —
/// `forge_status` handles that case separately so the UI can still render.
pub fn build(remote: &RemoteInfo, cwd: &Path) -> AppResult<Forge> {
    match remote.kind {
        ForgeKind::Gitlab => Ok(Forge::Gitlab(GitlabForge {
            cwd: cwd.to_path_buf(),
            host: remote.host.clone(),
            project: remote.project(),
        })),
        ForgeKind::Github => Ok(Forge::Github(GithubForge {
            cwd: cwd.to_path_buf(),
            host: remote.host.clone(),
            project: remote.project(),
        })),
        ForgeKind::Unknown => Err(AppError::Forge(format!(
            "unrecognized forge host: {}",
            remote.host
        ))),
    }
}

pub enum Forge {
    Gitlab(GitlabForge),
    Github(GithubForge),
}

/// Dispatch each capability to the active provider. The boilerplate is the
/// price of static dispatch over a closed provider set — worth it to keep a
/// concrete value across the Tauri command boundary.
impl Forge {
    pub async fn status(&self) -> AppResult<ForgeStatus> {
        match self {
            Forge::Gitlab(g) => g.status().await,
            Forge::Github(g) => g.status().await,
        }
    }
    pub async fn list_issues(
        &self,
        query: &str,
        state_filter: &str,
        limit: u32,
    ) -> AppResult<Vec<ForgeIssue>> {
        match self {
            Forge::Gitlab(g) => g.list_issues(query, state_filter, limit).await,
            Forge::Github(g) => g.list_issues(query, state_filter, limit).await,
        }
    }
    pub async fn get_issue(&self, number: u64) -> AppResult<ForgeIssue> {
        match self {
            Forge::Gitlab(g) => g.get_issue(number).await,
            Forge::Github(g) => g.get_issue(number).await,
        }
    }
    pub async fn list_mrs(&self, state_filter: &str, limit: u32) -> AppResult<Vec<ForgeMr>> {
        match self {
            Forge::Gitlab(g) => g.list_mrs(state_filter, limit).await,
            Forge::Github(g) => g.list_mrs(state_filter, limit).await,
        }
    }
    pub async fn find_mr_for_branch(&self, branch: &str) -> AppResult<Option<ForgeMr>> {
        match self {
            Forge::Gitlab(g) => g.find_mr_for_branch(branch).await,
            Forge::Github(g) => g.find_mr_for_branch(branch).await,
        }
    }
    pub async fn create_mr(
        &self,
        source: &str,
        target: &str,
        title: &str,
        body: &str,
        draft: bool,
    ) -> AppResult<ForgeMr> {
        match self {
            Forge::Gitlab(g) => g.create_mr(source, target, title, body, draft).await,
            Forge::Github(g) => g.create_mr(source, target, title, body, draft).await,
        }
    }
    pub async fn approve_mr(&self, iid: u64) -> AppResult<()> {
        match self {
            Forge::Gitlab(g) => g.approve_mr(iid).await,
            Forge::Github(g) => g.approve_mr(iid).await,
        }
    }
    pub async fn unapprove_mr(&self, iid: u64) -> AppResult<()> {
        match self {
            Forge::Gitlab(g) => g.unapprove_mr(iid).await,
            Forge::Github(g) => g.unapprove_mr(iid).await,
        }
    }
    pub async fn approval_state(&self, iid: u64) -> AppResult<ForgeApproval> {
        match self {
            Forge::Gitlab(g) => g.approval_state(iid).await,
            Forge::Github(g) => g.approval_state(iid).await,
        }
    }
    pub async fn merge_mr(&self, iid: u64) -> AppResult<()> {
        match self {
            Forge::Gitlab(g) => g.merge_mr(iid).await,
            Forge::Github(g) => g.merge_mr(iid).await,
        }
    }
    pub async fn post_mr_comment(&self, iid: u64, body: &str) -> AppResult<()> {
        match self {
            Forge::Gitlab(g) => g.post_mr_comment(iid, body).await,
            Forge::Github(g) => g.post_mr_comment(iid, body).await,
        }
    }
    pub async fn post_review_comments(
        &self,
        iid: u64,
        comments: &[ReviewCommentInput],
    ) -> AppResult<()> {
        match self {
            Forge::Gitlab(g) => g.post_review_comments(iid, comments).await,
            Forge::Github(g) => g.post_review_comments(iid, comments).await,
        }
    }
    pub async fn list_threads(&self, iid: u64) -> AppResult<Vec<ForgeThread>> {
        match self {
            Forge::Gitlab(g) => g.list_threads(iid).await,
            Forge::Github(g) => g.list_threads(iid).await,
        }
    }
    pub async fn reply_thread(&self, iid: u64, discussion_id: &str, body: &str) -> AppResult<()> {
        match self {
            Forge::Gitlab(g) => g.reply_thread(iid, discussion_id, body).await,
            Forge::Github(g) => g.reply_thread(iid, discussion_id, body).await,
        }
    }
    pub async fn resolve_thread(
        &self,
        iid: u64,
        discussion_id: &str,
        resolved: bool,
    ) -> AppResult<()> {
        match self {
            Forge::Gitlab(g) => g.resolve_thread(iid, discussion_id, resolved).await,
            Forge::Github(g) => g.resolve_thread(iid, discussion_id, resolved).await,
        }
    }
    pub async fn list_pipelines(&self, branch: &str) -> AppResult<Vec<ForgePipeline>> {
        match self {
            Forge::Gitlab(g) => g.list_pipelines(branch).await,
            Forge::Github(g) => g.list_pipelines(branch).await,
        }
    }
    pub async fn pipeline_jobs(&self, pipeline_id: u64) -> AppResult<Vec<ForgeJob>> {
        match self {
            Forge::Gitlab(g) => g.pipeline_jobs(pipeline_id).await,
            Forge::Github(g) => g.pipeline_jobs(pipeline_id).await,
        }
    }
    pub async fn job_log(&self, job_id: u64) -> AppResult<String> {
        match self {
            Forge::Gitlab(g) => g.job_log(job_id).await,
            Forge::Github(g) => g.job_log(job_id).await,
        }
    }
    pub async fn retry_pipeline(&self, pipeline_id: u64) -> AppResult<()> {
        match self {
            Forge::Gitlab(g) => g.retry_pipeline(pipeline_id).await,
            Forge::Github(g) => g.retry_pipeline(pipeline_id).await,
        }
    }
}
