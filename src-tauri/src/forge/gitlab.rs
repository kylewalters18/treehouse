//! GitLab provider — talks to the GitLab REST API v4 directly over HTTP
//! (`reqwest`), no `glab` CLI. Auth is a personal access token looked up by
//! host in `~/.netrc` (multi-host: each repo's remote host carries its own
//! token), sent as the `PRIVATE-TOKEN` header. The endpoint paths mirror what
//! we previously drove through `glab api`.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::forge::cli; // tail_bounded
use crate::forge::remote::percent_encode;
use crate::forge::types::*;
use crate::util::errors::{AppError, AppResult};

pub struct GitlabForge {
    /// API base, e.g. `https://gitlab.com`.
    pub base: String,
    /// Host, e.g. `gitlab.com` (for status display).
    pub host: String,
    /// PAT for this host from `~/.netrc`, if any.
    pub token: Option<String>,
    /// `owner/repo` (owner may include nested groups).
    pub project: String,
}

/// Process-wide HTTP client (connection pooling).
fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().build().expect("build reqwest client"))
}

impl GitlabForge {
    fn pid(&self) -> String {
        percent_encode(&self.project)
    }

    /// Issue a request to `/api/v4/<path>` with the token header and optional
    /// form body. Maps a transport error or non-2xx to `AppError::Forge`.
    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        form: &[(&str, String)],
    ) -> AppResult<String> {
        let url = format!("{}/api/v4/{}", self.base, path);
        let mut req = client().request(method, &url);
        if let Some(t) = &self.token {
            req = req.header("PRIVATE-TOKEN", t.as_str());
        }
        if !form.is_empty() {
            req = req.form(form);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| AppError::Forge(format!("request to {url} failed: {e}")))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            let snippet: String = body.chars().take(300).collect();
            return Err(AppError::Forge(format!(
                "GitLab {} on {path}: {snippet}",
                status.as_u16()
            )));
        }
        Ok(body)
    }

    async fn get(&self, path: &str) -> AppResult<String> {
        self.send(reqwest::Method::GET, path, &[]).await
    }

    fn parse<T: for<'de> Deserialize<'de>>(label: &str, json: &str) -> AppResult<T> {
        serde_json::from_str(json).map_err(|e| AppError::Forge(format!("parse {label}: {e}")))
    }

    // --- status ---

    pub async fn status(&self) -> AppResult<ForgeStatus> {
        // "installed" → a token is configured for this host.
        let installed = self.token.is_some();
        let (authenticated, username) = if installed {
            match self.current_user().await {
                Ok(u) => (true, Some(u.username)),
                Err(_) => (false, None),
            }
        } else {
            (false, None)
        };
        Ok(ForgeStatus {
            kind: ForgeKind::Gitlab,
            host: Some(self.host.clone()),
            installed,
            authenticated,
            username,
        })
    }

    async fn current_user(&self) -> AppResult<GlCurrentUser> {
        Self::parse("user", &self.get("user").await?)
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
        let raw: Vec<GlIssue> = Self::parse("issues", &self.get(&path).await?)?;
        Ok(raw.into_iter().map(GlIssue::normalize).collect())
    }

    pub async fn get_issue(&self, number: u64) -> AppResult<ForgeIssue> {
        let path = format!("projects/{}/issues/{}", self.pid(), number);
        let raw: GlIssue = Self::parse("issue", &self.get(&path).await?)?;
        Ok(raw.normalize())
    }

    pub async fn set_issue_assignee(&self, number: u64, assign: bool) -> AppResult<()> {
        let path = format!("projects/{}/issues/{}", self.pid(), number);
        // assignee_ids[]=<my id> assigns; assignee_ids[]=0 clears all.
        let id = if assign {
            self.current_user().await?.id.to_string()
        } else {
            "0".to_string()
        };
        self.send(reqwest::Method::PUT, &path, &[("assignee_ids[]", id)])
            .await
            .map(|_| ())
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
        let raw: Vec<GlMr> = Self::parse("merge_requests", &self.get(&path).await?)?;
        Ok(raw.into_iter().map(GlMr::normalize).collect())
    }

    pub async fn find_mr_for_branch(&self, branch: &str) -> AppResult<Option<ForgeMr>> {
        let path = format!(
            "projects/{}/merge_requests?source_branch={}&state=opened&per_page=1",
            self.pid(),
            percent_encode(branch)
        );
        let raw: Vec<GlMr> = Self::parse("merge_requests", &self.get(&path).await?)?;
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
        let path = format!("projects/{}/merge_requests", self.pid());
        let form = [
            ("source_branch", source.to_string()),
            ("target_branch", target.to_string()),
            ("title", title),
            ("description", body.to_string()),
            ("remove_source_branch", "true".to_string()),
        ];
        let mr: GlMr = Self::parse("create_mr", &self.send(reqwest::Method::POST, &path, &form).await?)?;
        Ok(mr.normalize())
    }

    pub async fn approve_mr(&self, iid: u64) -> AppResult<()> {
        let path = format!("projects/{}/merge_requests/{}/approve", self.pid(), iid);
        self.send(reqwest::Method::POST, &path, &[]).await.map(|_| ())
    }

    pub async fn unapprove_mr(&self, iid: u64) -> AppResult<()> {
        let path = format!("projects/{}/merge_requests/{}/unapprove", self.pid(), iid);
        self.send(reqwest::Method::POST, &path, &[]).await.map(|_| ())
    }

    pub async fn approval_state(&self, iid: u64) -> AppResult<ForgeApproval> {
        let path = format!("projects/{}/merge_requests/{}/approvals", self.pid(), iid);
        let raw: GlApprovals = Self::parse("approvals", &self.get(&path).await?)?;
        Ok(ForgeApproval {
            approved: raw.user_has_approved,
            can_approve: raw.user_can_approve,
        })
    }

    /// Merge immediately (no merge-when-pipeline-succeeds), squashing iff the
    /// project/MR calls for it (GitLab's `squash_on_merge`). A non-mergeable MR
    /// returns a 4xx, surfaced as an error rather than silently queued.
    pub async fn merge_mr(&self, iid: u64) -> AppResult<()> {
        let detail: GlMergeFlags = Self::parse(
            "mr_merge_flags",
            &self
                .get(&format!("projects/{}/merge_requests/{}", self.pid(), iid))
                .await?,
        )?;
        let path = format!("projects/{}/merge_requests/{}/merge", self.pid(), iid);
        let form: &[(&str, String)] = if detail.squash_on_merge {
            &[("squash", String::from("true"))]
        } else {
            &[]
        };
        self.send(reqwest::Method::PUT, &path, form).await.map(|_| ())
    }

    // --- comments / review threads ---

    pub async fn post_mr_comment(&self, iid: u64, body: &str) -> AppResult<()> {
        let path = format!("projects/{}/merge_requests/{}/notes", self.pid(), iid);
        self.send(reqwest::Method::POST, &path, &[("body", body.to_string())])
            .await
            .map(|_| ())
    }

    /// Line-anchored review comments. Fetches diff_refs, then posts one inline
    /// discussion per comment with the `position[...]` form fields. Collects
    /// per-comment failures (e.g. a line outside the diff).
    pub async fn post_review_comments(
        &self,
        iid: u64,
        comments: &[ReviewCommentInput],
    ) -> AppResult<()> {
        let refs = self.diff_refs(iid).await?;
        let path = format!("projects/{}/merge_requests/{}/discussions", self.pid(), iid);
        let mut failures = Vec::new();
        for c in comments {
            let form = [
                ("body", c.body.clone()),
                ("position[position_type]", "text".to_string()),
                ("position[base_sha]", refs.base_sha.clone()),
                ("position[start_sha]", refs.start_sha.clone()),
                ("position[head_sha]", refs.head_sha.clone()),
                ("position[new_path]", c.file_path.clone()),
                ("position[old_path]", c.file_path.clone()),
                ("position[new_line]", c.line.to_string()),
            ];
            if let Err(e) = self.send(reqwest::Method::POST, &path, &form).await {
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
        let raw: Vec<GlDiscussion> = Self::parse("discussions", &self.get(&path).await?)?;
        Ok(raw
            .into_iter()
            .map(GlDiscussion::normalize)
            .filter(|t| !t.notes.is_empty())
            .collect())
    }

    pub async fn reply_thread(&self, iid: u64, discussion_id: &str, body: &str) -> AppResult<()> {
        let path = format!(
            "projects/{}/merge_requests/{}/discussions/{}/notes",
            self.pid(),
            iid,
            discussion_id
        );
        self.send(reqwest::Method::POST, &path, &[("body", body.to_string())])
            .await
            .map(|_| ())
    }

    pub async fn resolve_thread(
        &self,
        iid: u64,
        discussion_id: &str,
        resolved: bool,
    ) -> AppResult<()> {
        let path = format!(
            "projects/{}/merge_requests/{}/discussions/{}",
            self.pid(),
            iid,
            discussion_id
        );
        self.send(reqwest::Method::PUT, &path, &[("resolved", resolved.to_string())])
            .await
            .map(|_| ())
    }

    async fn diff_refs(&self, iid: u64) -> AppResult<GlDiffRefs> {
        let path = format!("projects/{}/merge_requests/{}", self.pid(), iid);
        let detail: GlMrDetail = Self::parse("mr_detail", &self.get(&path).await?)?;
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
        let raw: Vec<GlPipeline> = Self::parse("pipelines", &self.get(&path).await?)?;
        Ok(raw.into_iter().map(GlPipeline::normalize).collect())
    }

    pub async fn pipeline_jobs(&self, pipeline_id: u64) -> AppResult<Vec<ForgeJob>> {
        let path = format!(
            "projects/{}/pipelines/{}/jobs?per_page=100&include_retried=true",
            self.pid(),
            pipeline_id
        );
        let raw: Vec<GlJob> = Self::parse("jobs", &self.get(&path).await?)?;
        Ok(raw.into_iter().map(GlJob::normalize).collect())
    }

    pub async fn job_log(&self, job_id: u64) -> AppResult<String> {
        let path = format!("projects/{}/jobs/{}/trace", self.pid(), job_id);
        Ok(cli::tail_bounded(&self.get(&path).await?, 16_000))
    }

    pub async fn retry_pipeline(&self, pipeline_id: u64) -> AppResult<()> {
        let path = format!("projects/{}/pipelines/{}/retry", self.pid(), pipeline_id);
        self.send(reqwest::Method::POST, &path, &[]).await.map(|_| ())
    }

    pub async fn retry_job(&self, job_id: u64) -> AppResult<()> {
        let path = format!("projects/{}/jobs/{}/retry", self.pid(), job_id);
        self.send(reqwest::Method::POST, &path, &[]).await.map(|_| ())
    }
}

// --- raw GitLab REST shapes (deserialize-only; normalized into TS types) ---

#[derive(Deserialize)]
struct GlCurrentUser {
    id: u64,
    #[serde(default)]
    username: String,
}

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
        let resolvable = notes.iter().any(|n| n.resolvable);
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
