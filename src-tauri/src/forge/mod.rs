//! Forge integration — issues, merge/pull requests, review threads, and CI —
//! GitLab over its REST API (token from `~/.netrc`), GitHub over the `gh` CLI.
//! The Rust side stays the source of truth; the renderer calls the `forge_*`
//! commands in `ipc::commands`.
//!
//! `Forge` is a closed two-variant enum (static dispatch, no `async-trait`);
//! both providers map into the same normalized types (`types.rs`).
//! Auto-detected per workspace from the git remote; never let the CLI infer
//! the host from cwd — we pass it explicitly.

pub mod cli;
pub mod github;
pub mod gitlab;
pub mod log;
pub mod netrc;
pub mod remote;
pub mod types;
pub mod workflow;

use std::path::Path;

pub use remote::RemoteInfo;
pub use types::*;

use github::GithubForge;
use gitlab::GitlabForge;

use crate::util::errors::{AppError, AppResult};

/// The current run of each job: GitLab lists superseded attempts too, and
/// doesn't reliably flag them `retried`, so keep the highest id per
/// stage + name (a retry always gets a higher id). Mirrors the renderer's
/// `latestJobsPerName`.
pub fn latest_jobs(jobs: Vec<ForgeJob>) -> Vec<ForgeJob> {
    let mut latest: Vec<ForgeJob> = Vec::new();
    for j in jobs {
        match latest
            .iter_mut()
            .find(|l| l.stage == j.stage && l.name == j.name)
        {
            Some(l) if j.id > l.id => *l = j,
            Some(_) => {}
            None => latest.push(j),
        }
    }
    latest.sort_by_key(|j| j.id);
    latest
}

/// Resolve the forge remote for a repo root: `git remote get-url origin`,
/// then parse. A host we can't classify by name (e.g. a self-managed GitLab at
/// `git.acme.io`) is promoted to GitLab when `~/.netrc` carries a token for it
/// — so detection follows your configured credentials, not just the hostname.
/// `Ok(None)` when there's no origin or it can't be classified at all.
pub async fn detect(repo_root: &Path) -> AppResult<Option<RemoteInfo>> {
    let url = crate::worktree::git_ops::remote_url(repo_root).await?;
    Ok(url.as_deref().and_then(remote::parse_remote).map(|mut r| {
        if matches!(r.kind, ForgeKind::Unknown) && netrc::token_for_host(&r.host).is_some() {
            r.kind = ForgeKind::Gitlab;
        }
        r
    }))
}

/// Construct the provider for a recognized remote. Errors on `Unknown` kind —
/// `forge_status` handles that case separately so the UI can still render.
pub fn build(remote: &RemoteInfo, cwd: &Path) -> AppResult<Forge> {
    match remote.kind {
        ForgeKind::Gitlab => Ok(Forge::Gitlab(GitlabForge {
            base: format!("https://{}", remote.host),
            host: remote.host.clone(),
            token: netrc::token_for_host(&remote.host),
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
    pub async fn list_issues(&self, q: &IssueQuery) -> AppResult<Vec<ForgeIssue>> {
        match self {
            Forge::Gitlab(g) => g.list_issues(q).await,
            Forge::Github(g) => g.list_issues(q).await,
        }
    }
    pub async fn get_issue(&self, number: u64) -> AppResult<ForgeIssue> {
        match self {
            Forge::Gitlab(g) => g.get_issue(number).await,
            Forge::Github(g) => g.get_issue(number).await,
        }
    }
    pub async fn create_issue(&self, title: &str, body: &str) -> AppResult<ForgeIssue> {
        match self {
            Forge::Gitlab(g) => g.create_issue(title, body).await,
            Forge::Github(g) => g.create_issue(title, body).await,
        }
    }
    /// Replace an issue's title and body. With `expected_updated_at` (the
    /// `updatedAt` the caller's copy was read at), re-read first and refuse
    /// with `AppError::Conflict` if it has changed since — so an edit made on
    /// the forge meanwhile is never silently overwritten. Neither forge offers
    /// a conditional write through these APIs, so this narrows the race
    /// rather than closing it.
    pub async fn update_issue(
        &self,
        number: u64,
        title: &str,
        body: &str,
        expected_updated_at: Option<&str>,
    ) -> AppResult<ForgeIssue> {
        if let Some(expected) = expected_updated_at {
            let current = self.get_issue(number).await?;
            if current.updated_at != expected {
                return Err(AppError::Conflict(format!(
                    "#{number} changed on the forge since you opened it"
                )));
            }
        }
        match self {
            Forge::Gitlab(g) => g.update_issue(number, title, body).await,
            Forge::Github(g) => g.update_issue(number, title, body).await,
        }
    }
    pub async fn set_issue_assignee(&self, number: u64, assign: bool) -> AppResult<()> {
        match self {
            Forge::Gitlab(g) => g.set_issue_assignee(number, assign).await,
            Forge::Github(g) => g.set_issue_assignee(number, assign).await,
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
    /// The log split into sections, for the viewer (up to ~1MB of tail).
    pub async fn job_log_sections(&self, job_id: u64) -> AppResult<ForgeJobLog> {
        match self {
            Forge::Gitlab(g) => g.job_log_sections(job_id).await,
            Forge::Github(g) => g.job_log_sections(job_id).await,
        }
    }
    pub async fn retry_pipeline(&self, pipeline_id: u64) -> AppResult<()> {
        match self {
            Forge::Gitlab(g) => g.retry_pipeline(pipeline_id).await,
            Forge::Github(g) => g.retry_pipeline(pipeline_id).await,
        }
    }
    pub async fn retry_job(&self, job_id: u64) -> AppResult<()> {
        match self {
            Forge::Gitlab(g) => g.retry_job(job_id).await,
            Forge::Github(g) => g.retry_job(job_id).await,
        }
    }
}
