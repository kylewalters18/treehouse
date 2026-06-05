//! GitHub provider — talks to `gh`. Status is implemented (cheap + useful so a
//! GitHub-remote workspace still reports auth state); the rest is stubbed until
//! stage 6, where each method maps to `gh ... --json` / `gh api` against the
//! same normalized types. The `Forge` enum already routes here, so filling
//! these in is purely additive.

use std::path::PathBuf;

use crate::forge::cli;
use crate::forge::types::*;
use crate::util::errors::{AppError, AppResult};

pub struct GithubForge {
    pub cwd: PathBuf,
    pub host: String,
    pub project: String,
}

fn todo<T>() -> AppResult<T> {
    Err(AppError::Forge(
        "GitHub provider not yet implemented (GitLab-first)".into(),
    ))
}

impl GithubForge {
    pub async fn status(&self) -> AppResult<ForgeStatus> {
        let installed = cli::installed("gh").await;
        let authenticated = if installed {
            cli::run("gh", &self.cwd, Some(&self.host), &["auth".into(), "status".into()])
                .await
                .is_ok()
        } else {
            false
        };
        Ok(ForgeStatus {
            kind: ForgeKind::Github,
            host: Some(self.host.clone()),
            installed,
            authenticated,
        })
    }

    pub async fn list_issues(&self, _q: &str, _state: &str, _limit: u32) -> AppResult<Vec<ForgeIssue>> {
        todo()
    }
    pub async fn get_issue(&self, _number: u64) -> AppResult<ForgeIssue> {
        todo()
    }
    pub async fn list_mrs(&self, _state: &str, _limit: u32) -> AppResult<Vec<ForgeMr>> {
        todo()
    }
    pub async fn find_mr_for_branch(&self, _branch: &str) -> AppResult<Option<ForgeMr>> {
        todo()
    }
    pub async fn create_mr(
        &self,
        _source: &str,
        _target: &str,
        _title: &str,
        _body: &str,
        _draft: bool,
    ) -> AppResult<ForgeMr> {
        todo()
    }
    pub async fn approve_mr(&self, _iid: u64) -> AppResult<()> {
        todo()
    }
    pub async fn unapprove_mr(&self, _iid: u64) -> AppResult<()> {
        todo()
    }
    pub async fn approval_state(&self, _iid: u64) -> AppResult<ForgeApproval> {
        todo()
    }
    pub async fn merge_mr(&self, _iid: u64) -> AppResult<()> {
        todo()
    }
    pub async fn post_mr_comment(&self, _iid: u64, _body: &str) -> AppResult<()> {
        todo()
    }
    pub async fn post_review_comments(
        &self,
        _iid: u64,
        _comments: &[ReviewCommentInput],
    ) -> AppResult<()> {
        todo()
    }
    pub async fn list_threads(&self, _iid: u64) -> AppResult<Vec<ForgeThread>> {
        todo()
    }
    pub async fn reply_thread(&self, _iid: u64, _discussion_id: &str, _body: &str) -> AppResult<()> {
        todo()
    }
    pub async fn resolve_thread(
        &self,
        _iid: u64,
        _discussion_id: &str,
        _resolved: bool,
    ) -> AppResult<()> {
        todo()
    }
    pub async fn list_pipelines(&self, _branch: &str) -> AppResult<Vec<ForgePipeline>> {
        todo()
    }
    pub async fn pipeline_jobs(&self, _pipeline_id: u64) -> AppResult<Vec<ForgeJob>> {
        todo()
    }
    pub async fn job_log(&self, _job_id: u64) -> AppResult<String> {
        todo()
    }
    pub async fn retry_pipeline(&self, _pipeline_id: u64) -> AppResult<()> {
        todo()
    }
}
