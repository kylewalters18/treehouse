//! GitLab provider — talks to `glab`. Strategy (decided with the user):
//! `glab api projects/<id>/...` for all structured reads + the positioned
//! writes (uniform, version-stable REST v4 schema), and porcelain only for
//! fire-and-forget actions where there's nothing to parse (`auth status`,
//! `mr merge`, `mr note`).
//!
//! The fiddly bit — inline review comments — MUST use `glab api --method POST
//! .../discussions --form "position[...]"` (multipart). `-f "position[...]"`
//! (JSON body) and `--input -` (no content-type → 415) both silently fail to
//! attach the position. Verified empirically against gitlab.com.

use std::path::PathBuf;

use serde::Deserialize;

use crate::forge::cli;
use crate::forge::remote::percent_encode;
use crate::forge::types::*;
use crate::util::errors::{AppError, AppResult};

pub struct GitlabForge {
    pub cwd: PathBuf,
    pub host: String,
    /// `owner/repo` (owner may include nested groups).
    pub project: String,
}

impl GitlabForge {
    /// URL-encoded project id for `projects/{id}` paths.
    fn pid(&self) -> String {
        percent_encode(&self.project)
    }

    async fn glab(&self, args: &[String]) -> AppResult<String> {
        cli::run("glab", &self.cwd, Some(&self.host), args).await
    }

    /// `glab api <args...>`.
    async fn api(&self, args: &[String]) -> AppResult<String> {
        let mut a = Vec::with_capacity(args.len() + 1);
        a.push("api".to_string());
        a.extend_from_slice(args);
        self.glab(&a).await
    }

    /// `glab api <path>` (GET).
    async fn api_get(&self, path: &str) -> AppResult<String> {
        self.api(&[path.to_string()]).await
    }

    fn parse<T: for<'de> Deserialize<'de>>(label: &str, json: &str) -> AppResult<T> {
        serde_json::from_str(json).map_err(|e| AppError::Forge(format!("parse {label}: {e}")))
    }

    // --- status ---

    pub async fn status(&self) -> AppResult<ForgeStatus> {
        let installed = cli::installed("glab").await;
        let authenticated = if installed {
            self.glab(&["auth".into(), "status".into()]).await.is_ok()
        } else {
            false
        };
        let username = if authenticated {
            self.current_username().await.ok()
        } else {
            None
        };
        Ok(ForgeStatus {
            kind: ForgeKind::Gitlab,
            host: Some(self.host.clone()),
            installed,
            authenticated,
            username,
        })
    }

    /// The authenticated user's username (`glab api user`).
    async fn current_username(&self) -> AppResult<String> {
        let raw: GlUser = Self::parse("user", &self.api_get("user").await?)?;
        Ok(raw.username)
    }

    /// Assign the issue to the current user, or unassign all (the "I'm taking
    /// this" toggle).
    pub async fn set_issue_assignee(&self, number: u64, assign: bool) -> AppResult<()> {
        let mut args = vec!["issue".into(), "update".into(), number.to_string()];
        if assign {
            args.push("--assignee".into());
            args.push(self.current_username().await?);
        } else {
            args.push("--unassign".into());
        }
        self.glab(&args).await.map(|_| ())
    }

    // --- issues ---

    pub async fn list_issues(
        &self,
        query: &str,
        state_filter: &str,
        limit: u32,
    ) -> AppResult<Vec<ForgeIssue>> {
        let mut path = format!(
            "projects/{}/issues?per_page={}&order_by=updated_at",
            self.pid(),
            limit
        );
        match state_filter {
            "closed" => path.push_str("&state=closed"),
            "all" => {}
            _ => path.push_str("&state=opened"),
        }
        let q = query.trim();
        if !q.is_empty() {
            path.push_str(&format!("&search={}", percent_encode(q)));
        }
        let raw: Vec<GlIssue> = Self::parse("issues", &self.api_get(&path).await?)?;
        Ok(raw.into_iter().map(GlIssue::normalize).collect())
    }

    pub async fn get_issue(&self, number: u64) -> AppResult<ForgeIssue> {
        let path = format!("projects/{}/issues/{}", self.pid(), number);
        let raw: GlIssue = Self::parse("issue", &self.api_get(&path).await?)?;
        Ok(raw.normalize())
    }

    // --- merge requests ---

    pub async fn list_mrs(&self, state_filter: &str, limit: u32) -> AppResult<Vec<ForgeMr>> {
        let mut path = format!(
            "projects/{}/merge_requests?per_page={}&order_by=updated_at",
            self.pid(),
            limit
        );
        match state_filter {
            "closed" => path.push_str("&state=closed"),
            "merged" => path.push_str("&state=merged"),
            "all" => {}
            _ => path.push_str("&state=opened"),
        }
        let raw: Vec<GlMr> = Self::parse("merge_requests", &self.api_get(&path).await?)?;
        Ok(raw.into_iter().map(GlMr::normalize).collect())
    }

    pub async fn find_mr_for_branch(&self, branch: &str) -> AppResult<Option<ForgeMr>> {
        let path = format!(
            "projects/{}/merge_requests?source_branch={}&state=opened&per_page=1",
            self.pid(),
            percent_encode(branch)
        );
        let raw: Vec<GlMr> = Self::parse("merge_requests", &self.api_get(&path).await?)?;
        Ok(raw.into_iter().next().map(GlMr::normalize))
    }

    pub async fn create_mr(
        &self,
        source: &str,
        target: &str,
        title: &str,
        body: &str,
        draft: bool,
    ) -> AppResult<ForgeMr> {
        let title = if draft {
            format!("Draft: {title}")
        } else {
            title.to_string()
        };
        let args = vec![
            "--method".into(),
            "POST".into(),
            format!("projects/{}/merge_requests", self.pid()),
            "-f".into(),
            format!("source_branch={source}"),
            "-f".into(),
            format!("target_branch={target}"),
            "-f".into(),
            format!("title={title}"),
            "-f".into(),
            format!("description={body}"),
            "-f".into(),
            "remove_source_branch=true".into(),
        ];
        let mr: GlMr = Self::parse("create_mr", &self.api(&args).await?)?;
        Ok(mr.normalize())
    }

    /// Approve the MR (porcelain action).
    pub async fn approve_mr(&self, iid: u64) -> AppResult<()> {
        self.glab(&["mr".into(), "approve".into(), iid.to_string()])
            .await
            .map(|_| ())
    }

    /// Revoke the current user's approval (porcelain action).
    pub async fn unapprove_mr(&self, iid: u64) -> AppResult<()> {
        self.glab(&["mr".into(), "revoke".into(), iid.to_string()])
            .await
            .map(|_| ())
    }

    /// The current user's approval state, from the approvals endpoint.
    pub async fn approval_state(&self, iid: u64) -> AppResult<ForgeApproval> {
        let path = format!("projects/{}/merge_requests/{}/approvals", self.pid(), iid);
        let raw: GlApprovals = Self::parse("approvals", &self.api_get(&path).await?)?;
        Ok(ForgeApproval {
            approved: raw.user_has_approved,
            can_approve: raw.user_can_approve,
        })
    }

    /// Merge the MR, deferring to the project's configured merge method
    /// (merge commit / rebase-merge / fast-forward). `--auto-merge=false`
    /// forces an immediate merge so a blocked MR (unresolved discussions,
    /// failing pipeline, missing approval, conflicts) **errors** instead of
    /// silently queuing auto-merge and reporting success.
    ///
    /// Squash: we read GitLab's own `squash_on_merge` off the live MR — it's
    /// computed from the project's squash setting (require / encourage / allow
    /// / never) combined with the MR's choice — and pass `--squash` iff true.
    /// Nothing hardcoded; a Require-squash project merges cleanly, a Never
    /// project doesn't get a rejected `--squash`.
    pub async fn merge_mr(&self, iid: u64) -> AppResult<()> {
        let detail: GlMergeFlags =
            Self::parse("mr_merge_flags", &self.api_get(&format!(
                "projects/{}/merge_requests/{}",
                self.pid(),
                iid
            )).await?)?;
        let mut args = vec![
            "mr".into(),
            "merge".into(),
            iid.to_string(),
            "-y".into(),
            "--auto-merge=false".into(),
        ];
        if detail.squash_on_merge {
            args.push("--squash".into());
        }
        self.glab(&args).await.map(|_| ())
    }

    // --- comments / review threads ---

    /// General (non-line) MR comment via porcelain.
    pub async fn post_mr_comment(&self, iid: u64, body: &str) -> AppResult<()> {
        self.glab(&[
            "mr".into(),
            "note".into(),
            iid.to_string(),
            "-m".into(),
            body.to_string(),
        ])
        .await
        .map(|_| ())
    }

    /// Line-anchored review comments. Fetches the MR's diff_refs (base/start/
    /// head SHA) and posts one inline discussion per comment via `--form`.
    /// Collects per-comment failures (e.g. a line outside the diff) and
    /// surfaces them rather than failing the whole batch silently.
    pub async fn post_review_comments(
        &self,
        iid: u64,
        comments: &[ReviewCommentInput],
    ) -> AppResult<()> {
        let refs = self.diff_refs(iid).await?;
        let mut failures = Vec::new();
        for c in comments {
            let args = vec![
                "--method".into(),
                "POST".into(),
                format!("projects/{}/merge_requests/{}/discussions", self.pid(), iid),
                "--form".into(),
                format!("body={}", c.body),
                "--form".into(),
                "position[position_type]=text".into(),
                "--form".into(),
                format!("position[base_sha]={}", refs.base_sha),
                "--form".into(),
                format!("position[start_sha]={}", refs.start_sha),
                "--form".into(),
                format!("position[head_sha]={}", refs.head_sha),
                "--form".into(),
                format!("position[new_path]={}", c.file_path),
                "--form".into(),
                format!("position[old_path]={}", c.file_path),
                "--form".into(),
                format!("position[new_line]={}", c.line),
            ];
            if let Err(e) = self.api(&args).await {
                failures.push(format!("{}:{} — {e}", c.file_path, c.line));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Forge(format!(
                "{} of {} comment(s) failed to post:\n{}",
                failures.len(),
                comments.len(),
                failures.join("\n")
            )))
        }
    }

    pub async fn list_threads(&self, iid: u64) -> AppResult<Vec<ForgeThread>> {
        let path = format!(
            "projects/{}/merge_requests/{}/discussions?per_page=100",
            self.pid(),
            iid
        );
        let raw: Vec<GlDiscussion> = Self::parse("discussions", &self.api_get(&path).await?)?;
        Ok(raw
            .into_iter()
            .map(GlDiscussion::normalize)
            .filter(|t| !t.notes.is_empty())
            .collect())
    }

    /// Resolve / unresolve a whole discussion thread (projects that require
    /// all threads resolved before merge depend on this).
    pub async fn resolve_thread(
        &self,
        iid: u64,
        discussion_id: &str,
        resolved: bool,
    ) -> AppResult<()> {
        let args = vec![
            "--method".into(),
            "PUT".into(),
            format!(
                "projects/{}/merge_requests/{}/discussions/{}",
                self.pid(),
                iid,
                discussion_id
            ),
            "-f".into(),
            format!("resolved={resolved}"),
        ];
        self.api(&args).await.map(|_| ())
    }

    pub async fn reply_thread(&self, iid: u64, discussion_id: &str, body: &str) -> AppResult<()> {
        let args = vec![
            "--method".into(),
            "POST".into(),
            format!(
                "projects/{}/merge_requests/{}/discussions/{}/notes",
                self.pid(),
                iid,
                discussion_id
            ),
            "-f".into(),
            format!("body={body}"),
        ];
        self.api(&args).await.map(|_| ())
    }

    async fn diff_refs(&self, iid: u64) -> AppResult<GlDiffRefs> {
        let path = format!("projects/{}/merge_requests/{}", self.pid(), iid);
        let detail: GlMrDetail = Self::parse("mr_detail", &self.api_get(&path).await?)?;
        detail
            .diff_refs
            .ok_or_else(|| AppError::Forge("MR has no diff_refs (no diff to anchor to)".into()))
    }

    // --- CI / pipelines ---

    pub async fn list_pipelines(&self, branch: &str) -> AppResult<Vec<ForgePipeline>> {
        let path = format!(
            "projects/{}/pipelines?ref={}&per_page=20",
            self.pid(),
            percent_encode(branch)
        );
        let raw: Vec<GlPipeline> = Self::parse("pipelines", &self.api_get(&path).await?)?;
        Ok(raw.into_iter().map(GlPipeline::normalize).collect())
    }

    pub async fn pipeline_jobs(&self, pipeline_id: u64) -> AppResult<Vec<ForgeJob>> {
        // include_retried so superseded runs are present — needed to order
        // stages by their earliest job id (a retry gets a higher id and would
        // otherwise drag its stage out of order). The UI shows only the
        // current run (retried=false) but orders stages using all of them.
        let path = format!(
            "projects/{}/pipelines/{}/jobs?per_page=100&include_retried=true",
            self.pid(),
            pipeline_id
        );
        let raw: Vec<GlJob> = Self::parse("jobs", &self.api_get(&path).await?)?;
        Ok(raw.into_iter().map(GlJob::normalize).collect())
    }

    pub async fn job_log(&self, job_id: u64) -> AppResult<String> {
        let path = format!("projects/{}/jobs/{}/trace", self.pid(), job_id);
        Ok(cli::tail_bounded(&self.api_get(&path).await?, 16_000))
    }

    pub async fn retry_pipeline(&self, pipeline_id: u64) -> AppResult<()> {
        let args = vec![
            "--method".into(),
            "POST".into(),
            format!("projects/{}/pipelines/{}/retry", self.pid(), pipeline_id),
        ];
        self.api(&args).await.map(|_| ())
    }

    /// Retry a single job (creates a fresh run of just that job).
    pub async fn retry_job(&self, job_id: u64) -> AppResult<()> {
        let args = vec![
            "--method".into(),
            "POST".into(),
            format!("projects/{}/jobs/{}/retry", self.pid(), job_id),
        ];
        self.api(&args).await.map(|_| ())
    }
}

// --- raw GitLab REST shapes (deserialize-only; normalized into TS types) ---

#[derive(Deserialize)]
struct GlUser {
    #[serde(default)]
    username: String,
}

#[derive(Deserialize)]
struct GlIssue {
    iid: u64,
    title: String,
    #[serde(default)]
    description: Option<String>,
    state: String,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    assignees: Vec<GlUser>,
    web_url: String,
    #[serde(default)]
    updated_at: String,
}

impl GlIssue {
    fn normalize(self) -> ForgeIssue {
        ForgeIssue {
            number: self.iid,
            title: self.title,
            body: self.description.unwrap_or_default(),
            state: normalize_state(&self.state),
            labels: self.labels,
            assignees: self.assignees.into_iter().map(|u| u.username).collect(),
            url: self.web_url,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Deserialize)]
struct GlMr {
    iid: u64,
    title: String,
    source_branch: String,
    target_branch: String,
    state: String,
    web_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    detailed_merge_status: Option<String>,
}

impl GlMr {
    fn normalize(self) -> ForgeMr {
        ForgeMr {
            number: self.iid,
            title: self.title,
            source_branch: self.source_branch,
            target_branch: self.target_branch,
            state: normalize_state(&self.state),
            url: self.web_url,
            draft: self.draft,
            merge_status: self.detailed_merge_status,
        }
    }
}

#[derive(Deserialize)]
struct GlMrDetail {
    diff_refs: Option<GlDiffRefs>,
}

/// Just the squash decision GitLab computed for this MR (project setting + MR
/// choice). `squash_on_merge` is true whenever the merge will squash.
#[derive(Deserialize)]
struct GlMergeFlags {
    #[serde(default)]
    squash_on_merge: bool,
}

#[derive(Deserialize)]
struct GlApprovals {
    #[serde(default)]
    user_has_approved: bool,
    #[serde(default)]
    user_can_approve: bool,
}

#[derive(Deserialize)]
struct GlDiffRefs {
    base_sha: String,
    start_sha: String,
    head_sha: String,
}

#[derive(Deserialize)]
struct GlPipeline {
    id: u64,
    #[serde(rename = "ref", default)]
    ref_name: String,
    #[serde(default)]
    sha: String,
    status: String,
    #[serde(default)]
    web_url: String,
    #[serde(default)]
    created_at: String,
}

impl GlPipeline {
    fn normalize(self) -> ForgePipeline {
        ForgePipeline {
            id: self.id,
            ref_name: self.ref_name,
            sha: self.sha,
            status: self.status,
            web_url: self.web_url,
            created_at: self.created_at,
        }
    }
}

#[derive(Deserialize)]
struct GlJob {
    id: u64,
    name: String,
    #[serde(default)]
    stage: String,
    status: String,
    #[serde(default)]
    retried: bool,
}

impl GlJob {
    fn normalize(self) -> ForgeJob {
        ForgeJob {
            id: self.id,
            name: self.name,
            stage: self.stage,
            status: self.status,
            retried: self.retried,
        }
    }
}

#[derive(Deserialize)]
struct GlDiscussion {
    id: String,
    #[serde(default)]
    notes: Vec<GlNote>,
}

impl GlDiscussion {
    fn normalize(self) -> ForgeThread {
        let notes: Vec<GlNote> = self.notes.into_iter().filter(|n| !n.system).collect();
        let resolvable_notes = notes.iter().filter(|n| n.resolvable).count();
        let resolvable = resolvable_notes > 0;
        // Resolved iff every resolvable note is resolved.
        let resolved = resolvable && notes.iter().filter(|n| n.resolvable).all(|n| n.resolved);
        ForgeThread {
            id: self.id,
            notes: notes.into_iter().map(GlNote::normalize).collect(),
            resolvable,
            resolved,
        }
    }
}

#[derive(Deserialize)]
struct GlNote {
    id: u64,
    body: String,
    #[serde(default)]
    author: Option<GlUser>,
    position: Option<GlPosition>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    system: bool,
    #[serde(default)]
    resolvable: bool,
    #[serde(default)]
    resolved: bool,
}

impl GlNote {
    fn normalize(self) -> ForgeNote {
        ForgeNote {
            id: self.id,
            author: self.author.map(|a| a.username).unwrap_or_default(),
            body: self.body,
            position: self.position.map(GlPosition::normalize),
            created_at: self.created_at,
        }
    }
}

#[derive(Deserialize)]
struct GlPosition {
    #[serde(default)]
    new_path: Option<String>,
    #[serde(default)]
    new_line: Option<u32>,
    #[serde(default)]
    old_path: Option<String>,
    #[serde(default)]
    old_line: Option<u32>,
}

impl GlPosition {
    fn normalize(self) -> ForgePosition {
        ForgePosition {
            new_path: self.new_path,
            new_line: self.new_line,
            old_path: self.old_path,
            old_line: self.old_line,
        }
    }
}
