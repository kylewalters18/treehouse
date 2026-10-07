//! GitHub provider — talks to `gh`. Porcelain `gh issue/pr … --json` for
//! issues and PRs, `gh api` (REST) for Actions and merging, and `gh api
//! graphql` for review threads (resolve state and thread replies are
//! GraphQL-only). Auth is whatever `gh auth login` set up; we never see a token.
//!
//! GitHub Actions maps onto the pipeline model like this: one *pipeline* is
//! every workflow run for a branch's head commit (a push usually fans out to
//! several workflows), identified by its newest run id; each workflow becomes
//! a *stage* and its jobs the stage's jobs. Statuses are normalized to the
//! GitLab vocabulary the CI panel already speaks (`failed`, `running`, …).

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::json;
use tokio::task::JoinSet;

use crate::forge::cli;
use crate::forge::log;
use crate::forge::remote::percent_encode;
use crate::forge::types::*;
use crate::util::errors::{AppError, AppResult};

pub struct GithubForge {
    pub cwd: PathBuf,
    pub host: String,
    /// `owner/repo`.
    pub project: String,
}

const ISSUE_FIELDS: &str = "number,title,body,state,labels,assignees,url,updatedAt";
const PR_FIELDS: &str =
    "number,title,headRefName,baseRefName,state,url,isDraft,mergeStateStatus,reviewDecision";

impl GithubForge {
    /// `HOST/OWNER/REPO` for `-R`, so `gh` never infers the repo from cwd.
    fn repo_arg(&self) -> String {
        format!("{}/{}", self.host, self.project)
    }

    fn owner_name(&self) -> (&str, &str) {
        self.project.split_once('/').unwrap_or((&self.project, ""))
    }

    async fn gh(&self, args: &[String]) -> AppResult<String> {
        cli::run("gh", &self.cwd, Some(&self.host), args).await
    }

    /// `gh api <path>` plus extra flags (`-X`, `-f`, …).
    async fn api(&self, path: &str, extra: &[String]) -> AppResult<String> {
        let mut args = vec!["api".to_string(), path.to_string()];
        args.extend_from_slice(extra);
        self.gh(&args).await
    }

    /// `gh api <path> --input -` with a JSON body on stdin.
    async fn api_json(
        &self,
        method: &str,
        path: &str,
        body: &serde_json::Value,
    ) -> AppResult<String> {
        let args: Vec<String> = ["api", "-X", method, path, "--input", "-"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        cli::run_with_input(
            "gh",
            &self.cwd,
            Some(&self.host),
            &args,
            Some(&body.to_string()),
        )
        .await
    }

    /// `gh api graphql` with `owner`/`name` bound when the query declares them. `vars` are typed
    /// fields (`-F`, so `number=3` arrives as an Int); `strs` are raw
    /// strings (`-f`, so free text is never reinterpreted).
    async fn graphql<T: for<'de> Deserialize<'de>>(
        &self,
        query: &str,
        vars: &[(&str, String)],
        strs: &[(&str, String)],
    ) -> AppResult<T> {
        let mut args = vec![
            "api".to_string(),
            "graphql".to_string(),
            "-f".to_string(),
            format!("query={query}"),
        ];
        // Mutations address nodes by id and don't declare these.
        if query.contains("$owner") {
            let (owner, name) = self.owner_name();
            args.extend([
                "-f".into(),
                format!("owner={owner}"),
                "-f".into(),
                format!("name={name}"),
            ]);
        }
        for (k, v) in vars {
            args.push("-F".into());
            args.push(format!("{k}={v}"));
        }
        for (k, v) in strs {
            args.push("-f".into());
            args.push(format!("{k}={v}"));
        }
        let raw: GqlResponse<T> = parse("graphql", &self.gh(&args).await?)?;
        raw.data
            .ok_or_else(|| AppError::Forge("GitHub GraphQL returned no data".into()))
    }

    // --- status ---

    pub async fn status(&self) -> AppResult<ForgeStatus> {
        let installed = cli::installed("gh").await;
        let username = if installed {
            self.api("user", &[])
                .await
                .ok()
                .and_then(|s| parse::<GhUser>("user", &s).ok())
                .map(|u| u.login)
        } else {
            None
        };
        Ok(ForgeStatus {
            kind: ForgeKind::Github,
            host: Some(self.host.clone()),
            installed,
            authenticated: username.is_some(),
            username,
        })
    }

    // --- issues ---

    pub async fn list_issues(&self, q: &IssueQuery) -> AppResult<Vec<ForgeIssue>> {
        let mut args = strs(&["issue", "list", "-R"]);
        args.push(self.repo_arg());
        args.extend(issue_list_args(q));
        let raw: Vec<GhIssue> = parse("issues", &self.gh(&args).await?)?;
        Ok(raw.into_iter().map(GhIssue::normalize).collect())
    }

    pub async fn get_issue(&self, number: u64) -> AppResult<ForgeIssue> {
        let mut args = strs(&["issue", "view"]);
        args.extend([
            number.to_string(),
            "-R".into(),
            self.repo_arg(),
            "--json".into(),
            ISSUE_FIELDS.into(),
        ]);
        let raw: GhIssue = parse("issue", &self.gh(&args).await?)?;
        Ok(raw.normalize())
    }

    /// `gh issue create` prints the new issue's URL; re-read it for the
    /// normalized shape.
    pub async fn create_issue(&self, title: &str, body: &str) -> AppResult<ForgeIssue> {
        let mut args = strs(&["issue", "create", "-R"]);
        args.extend([
            self.repo_arg(),
            "--title".into(),
            title.into(),
            "--body".into(),
            body.into(),
        ]);
        let out = self.gh(&args).await?;
        let number = number_from_url(&out, "/issues/").ok_or_else(|| {
            AppError::Forge(format!(
                "couldn't read issue number from gh output: {}",
                out.trim()
            ))
        })?;
        self.get_issue(number).await
    }

    pub async fn update_issue(
        &self,
        number: u64,
        title: &str,
        body: &str,
    ) -> AppResult<ForgeIssue> {
        let mut args = strs(&["issue", "edit"]);
        args.extend([
            number.to_string(),
            "-R".into(),
            self.repo_arg(),
            "--title".into(),
            title.into(),
            "--body".into(),
            body.into(),
        ]);
        self.gh(&args).await?;
        self.get_issue(number).await
    }

    /// Assign/unassign the current user (`@me`). Unlike GitLab's clear-all,
    /// unassigning only removes you — other assignees are left alone.
    pub async fn set_issue_assignee(&self, number: u64, assign: bool) -> AppResult<()> {
        let flag = if assign {
            "--add-assignee"
        } else {
            "--remove-assignee"
        };
        let mut args = strs(&["issue", "edit"]);
        args.extend([
            number.to_string(),
            "-R".into(),
            self.repo_arg(),
            flag.into(),
            "@me".into(),
        ]);
        self.gh(&args).await.map(|_| ())
    }

    // --- pull requests ---

    async fn pr_list(&self, extra: &[String]) -> AppResult<Vec<ForgeMr>> {
        let mut args = strs(&["pr", "list", "-R"]);
        args.push(self.repo_arg());
        args.extend_from_slice(extra);
        args.extend(["--json".into(), PR_FIELDS.into()]);
        let raw: Vec<GhPr> = parse("pull requests", &self.gh(&args).await?)?;
        Ok(raw.into_iter().map(GhPr::normalize).collect())
    }

    async fn get_pr(&self, number: u64) -> AppResult<ForgeMr> {
        let mut args = strs(&["pr", "view"]);
        args.extend([
            number.to_string(),
            "-R".into(),
            self.repo_arg(),
            "--json".into(),
            PR_FIELDS.into(),
        ]);
        let raw: GhPr = parse("pull request", &self.gh(&args).await?)?;
        Ok(raw.normalize())
    }

    pub async fn list_mrs(&self, state_filter: &str, limit: u32) -> AppResult<Vec<ForgeMr>> {
        let state = match state_filter {
            "closed" | "merged" | "all" => state_filter,
            _ => "open",
        };
        self.pr_list(&[
            "--state".into(),
            state.into(),
            "--limit".into(),
            limit.to_string(),
        ])
        .await
    }

    pub async fn find_mr_for_branch(&self, branch: &str) -> AppResult<Option<ForgeMr>> {
        let prs = self
            .pr_list(&[
                "--head".into(),
                branch.into(),
                "--state".into(),
                "open".into(),
                "--limit".into(),
                "1".into(),
            ])
            .await?;
        Ok(prs.into_iter().next())
    }

    /// The branch is already pushed (`forge_create_mr` does that), so
    /// `--head` keeps `gh` from trying to push or prompt. `gh pr create`
    /// prints the PR URL; we re-read the PR for the normalized shape.
    pub async fn create_mr(
        &self,
        source: &str,
        target: &str,
        title: &str,
        body: &str,
        draft: bool,
    ) -> AppResult<ForgeMr> {
        let mut args = strs(&["pr", "create", "-R"]);
        args.extend([
            self.repo_arg(),
            "--head".into(),
            source.into(),
            "--base".into(),
            target.into(),
            "--title".into(),
            title.into(),
            "--body".into(),
            body.into(),
        ]);
        if draft {
            args.push("--draft".into());
        }
        let out = self.gh(&args).await?;
        let number = number_from_url(&out, "/pull/").ok_or_else(|| {
            AppError::Forge(format!(
                "couldn't read PR number from gh output: {}",
                out.trim()
            ))
        })?;
        self.get_pr(number).await
    }

    pub async fn approve_mr(&self, iid: u64) -> AppResult<()> {
        let mut args = strs(&["pr", "review"]);
        args.extend([
            iid.to_string(),
            "-R".into(),
            self.repo_arg(),
            "--approve".into(),
        ]);
        self.gh(&args).await.map(|_| ())
    }

    /// GitHub has no "unapprove" — the closest equivalent is dismissing your
    /// own approving review, which needs write access to the repo.
    pub async fn unapprove_mr(&self, iid: u64) -> AppResult<()> {
        let review = self
            .approval_query(iid)
            .await?
            .own_approval()
            .ok_or_else(|| AppError::Forge("you haven't approved this PR".into()))?;
        self.graphql::<serde_json::Value>(
            "mutation($id:ID!,$msg:String!){dismissPullRequestReview(input:{pullRequestReviewId:$id,message:$msg}){clientMutationId}}",
            &[],
            &[("id", review), ("msg", "Approval revoked".into())],
        )
        .await
        .map(|_| ())
    }

    pub async fn approval_state(&self, iid: u64) -> AppResult<ForgeApproval> {
        let q = self.approval_query(iid).await?;
        let approved = q.own_approval().is_some();
        // GitHub refuses self-approval; only reviewers on an open PR can approve.
        let pr = &q.repository.pull_request;
        let is_author = pr.author.as_ref().map(|a| a.login.as_str()) == Some(&q.viewer.login);
        Ok(ForgeApproval {
            approved,
            can_approve: !is_author && pr.state == "OPEN",
        })
    }

    async fn approval_query(&self, iid: u64) -> AppResult<GqlApproval> {
        self.graphql(
            "query($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$number){state author{login} latestOpinionatedReviews(first:100){nodes{id state author{login}}}}}}",
            &[("number", iid.to_string())],
            &[],
        )
        .await
    }

    /// Merge now via REST (not `gh pr merge`, which also checks out and
    /// deletes the *local* branch — wrong inside a worktree). GitHub has no
    /// single project merge method, so pick the first the repo allows in the
    /// web UI's order: merge commit, squash, rebase. Branch deletion follows
    /// the repo's own "automatically delete head branches" setting.
    pub async fn merge_mr(&self, iid: u64) -> AppResult<()> {
        let repo: GhRepoSettings = parse(
            "repo",
            &self.api(&format!("repos/{}", self.project), &[]).await?,
        )?;
        let method = if repo.allow_merge_commit {
            "merge"
        } else if repo.allow_squash_merge {
            "squash"
        } else if repo.allow_rebase_merge {
            "rebase"
        } else {
            return Err(AppError::Forge("repo allows no merge method".into()));
        };
        self.api(
            &format!("repos/{}/pulls/{}/merge", self.project, iid),
            &strs(&["-X", "PUT", "-f", &format!("merge_method={method}")]),
        )
        .await
        .map(|_| ())
    }

    // --- comments / review threads ---

    pub async fn post_mr_comment(&self, iid: u64, body: &str) -> AppResult<()> {
        self.api(
            &format!("repos/{}/issues/{}/comments", self.project, iid),
            &["-f".into(), format!("body={body}")],
        )
        .await
        .map(|_| ())
    }

    /// Post all comments as one review (one notification). If GitHub rejects
    /// the batch — typically one line falls outside the diff — fall back to
    /// posting each comment on its own so the valid ones still land, and
    /// report the rest.
    pub async fn post_review_comments(
        &self,
        iid: u64,
        comments: &[ReviewCommentInput],
    ) -> AppResult<()> {
        let head: GhPrHead = parse(
            "pr",
            &self
                .api(&format!("repos/{}/pulls/{}", self.project, iid), &[])
                .await?,
        )?;
        let commit_id = head.head.sha;
        let item = |c: &ReviewCommentInput| {
            json!({
                "path": c.file_path,
                "line": c.line,
                // Removed lines anchor on the base side; everything else on the head.
                "side": if c.removed { "LEFT" } else { "RIGHT" },
                "body": c.body,
            })
        };
        let review = json!({
            "commit_id": commit_id,
            "event": "COMMENT",
            "comments": comments.iter().map(item).collect::<Vec<_>>(),
        });
        let reviews_path = format!("repos/{}/pulls/{}/reviews", self.project, iid);
        if self.api_json("POST", &reviews_path, &review).await.is_ok() {
            return Ok(());
        }
        let comments_path = format!("repos/{}/pulls/{}/comments", self.project, iid);
        let mut failures = Vec::new();
        for c in comments {
            let mut body = item(c);
            body["commit_id"] = json!(commit_id);
            if let Err(e) = self.api_json("POST", &comments_path, &body).await {
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

    /// Review threads (resolvable, inline), plus the PR conversation — issue
    /// comments and non-empty review summaries — each as a one-note,
    /// non-resolvable thread. Ordered by first note, like GitLab discussions.
    pub async fn list_threads(&self, iid: u64) -> AppResult<Vec<ForgeThread>> {
        let q: GqlThreads = self
            .graphql(
                "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){\
                 reviewThreads(first:100){nodes{id isResolved path line originalLine diffSide comments(first:100){nodes{databaseId author{login} body createdAt}}}}\
                 comments(first:100){nodes{id databaseId author{login} body createdAt}}\
                 reviews(first:100){nodes{id databaseId author{login} body createdAt}}}}}",
                &[("number", iid.to_string())],
                &[],
            )
            .await?;
        let pr = q.repository.pull_request;
        let mut threads: Vec<ForgeThread> = pr
            .review_threads
            .nodes
            .into_iter()
            .map(GqlReviewThread::normalize)
            .filter(|t| !t.notes.is_empty())
            .collect();
        threads.extend(
            pr.comments
                .nodes
                .into_iter()
                .chain(
                    pr.reviews
                        .nodes
                        .into_iter()
                        .filter(|r| !r.body.trim().is_empty()),
                )
                .map(GqlComment::into_thread),
        );
        threads.sort_by(|a, b| a.notes[0].created_at.cmp(&b.notes[0].created_at));
        Ok(threads)
    }

    /// Review threads (`PRRT_…` ids) take a threaded reply; GitHub's PR
    /// conversation is flat, so replying to a general comment posts a new one.
    pub async fn reply_thread(&self, iid: u64, discussion_id: &str, body: &str) -> AppResult<()> {
        if !is_review_thread(discussion_id) {
            return self.post_mr_comment(iid, body).await;
        }
        self.graphql::<serde_json::Value>(
            "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){clientMutationId}}",
            &[],
            &[("id", discussion_id.into()), ("body", body.into())],
        )
        .await
        .map(|_| ())
    }

    pub async fn resolve_thread(
        &self,
        _iid: u64,
        discussion_id: &str,
        resolved: bool,
    ) -> AppResult<()> {
        if !is_review_thread(discussion_id) {
            return Err(AppError::Forge(
                "only review threads can be resolved".into(),
            ));
        }
        let mutation = if resolved {
            "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){clientMutationId}}"
        } else {
            "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){clientMutationId}}"
        };
        self.graphql::<serde_json::Value>(mutation, &[], &[("id", discussion_id.into())])
            .await
            .map(|_| ())
    }

    // --- CI (GitHub Actions) ---

    async fn runs(&self, query: &str) -> AppResult<Vec<GhRun>> {
        let path = format!("repos/{}/actions/runs?per_page=100&{query}", self.project);
        let raw: GhRuns = parse("workflow runs", &self.api(&path, &[]).await?)?;
        Ok(raw.workflow_runs)
    }

    /// All runs that make up the pipeline anchored at `run_id`: same head
    /// commit, same branch (a commit can also run on `main` after merging).
    async fn pipeline_runs(&self, run_id: u64) -> AppResult<Vec<GhRun>> {
        let anchor: GhRun = parse(
            "workflow run",
            &self
                .api(
                    &format!("repos/{}/actions/runs/{run_id}", self.project),
                    &[],
                )
                .await?,
        )?;
        let runs = self.runs(&format!("head_sha={}", anchor.head_sha)).await?;
        Ok(runs
            .into_iter()
            .filter(|r| r.head_branch == anchor.head_branch)
            .collect())
    }

    pub async fn list_pipelines(&self, branch: &str) -> AppResult<Vec<ForgePipeline>> {
        let runs = self
            .runs(&format!("branch={}", percent_encode(branch)))
            .await?;
        // Group by head commit, keeping the API's newest-first order.
        let mut groups: Vec<(String, Vec<GhRun>)> = Vec::new();
        for r in runs {
            match groups.iter_mut().find(|(sha, _)| *sha == r.head_sha) {
                Some((_, g)) => g.push(r),
                None => groups.push((r.head_sha.clone(), vec![r])),
            }
        }
        let branch_url = format!(
            "https://{}/{}/actions?query=branch%3A{}",
            self.host,
            self.project,
            percent_encode(branch)
        );
        Ok(groups
            .into_iter()
            .map(|(sha, runs)| {
                let statuses: Vec<String> = runs
                    .iter()
                    .map(|r| ci_status(&r.status, r.conclusion.as_deref()))
                    .collect();
                let newest = runs.iter().max_by_key(|r| r.id).expect("non-empty group");
                let title = runs
                    .iter()
                    .find_map(|r| r.head_commit.as_ref())
                    .and_then(|c| c.message.lines().next())
                    .map(str::to_string);
                ForgePipeline {
                    title,
                    id: newest.id,
                    ref_name: newest.head_branch.clone(),
                    sha,
                    status: rollup(&statuses),
                    web_url: if runs.len() == 1 {
                        newest.html_url.clone()
                    } else {
                        branch_url.clone()
                    },
                    created_at: runs
                        .iter()
                        .map(|r| r.created_at.clone())
                        .min()
                        .unwrap_or_default(),
                }
            })
            .collect())
    }

    /// Jobs of every run in the pipeline, fetched concurrently; the workflow
    /// name is the stage.
    pub async fn pipeline_jobs(&self, pipeline_id: u64) -> AppResult<Vec<ForgeJob>> {
        let runs = self.pipeline_runs(pipeline_id).await?;
        let mut set = JoinSet::new();
        for run in runs {
            let (cwd, host) = (self.cwd.clone(), self.host.clone());
            let path = format!(
                "repos/{}/actions/runs/{}/jobs?per_page=100",
                self.project, run.id
            );
            set.spawn(async move {
                let out = cli::run("gh", &cwd, Some(&host), &["api".into(), path]).await?;
                let raw: GhJobs = parse("jobs", &out)?;
                Ok::<_, AppError>((run.name, raw.jobs))
            });
        }
        let mut jobs = Vec::new();
        while let Some(res) = set.join_next().await {
            let (stage, run_jobs) =
                res.map_err(|e| AppError::Forge(format!("jobs task: {e}")))??;
            jobs.extend(run_jobs.into_iter().map(|j| ForgeJob {
                id: j.id,
                status: ci_status(&j.status, j.conclusion.as_deref()),
                name: j.name,
                stage: stage.clone(),
                retried: false,
                attempt: j.run_attempt.max(1),
                started_at: j.started_at,
                finished_at: j.completed_at,
                web_url: j.html_url,
                allow_failure: false,
            }));
        }
        jobs.sort_by_key(|j| j.id);
        Ok(jobs)
    }

    pub async fn job_log(&self, job_id: u64) -> AppResult<String> {
        let raw = self
            .api(
                &format!("repos/{}/actions/jobs/{job_id}/logs", self.project),
                &[],
            )
            .await?;
        Ok(cli::tail_bounded(&strip_log_timestamps(&raw), 16_000))
    }

    /// The log split by step. The log and the job (for its steps' start
    /// times) are fetched concurrently.
    pub async fn job_log_sections(&self, job_id: u64) -> AppResult<ForgeJobLog> {
        let log_path = format!("repos/{}/actions/jobs/{job_id}/logs", self.project);
        let job_path = format!("repos/{}/actions/jobs/{job_id}", self.project);
        let (raw, job) = tokio::join!(self.api(&log_path, &[]), self.api(&job_path, &[]));
        let raw = raw?;
        let steps: Vec<log::Step> = job
            .ok()
            .and_then(|j| serde_json::from_str::<GhJobDetail>(&j).ok())
            .map(|j| {
                j.steps
                    .into_iter()
                    .map(|s| log::Step {
                        status: ci_status(&s.status, s.conclusion.as_deref()),
                        name: s.name,
                        started_at: s.started_at,
                        completed_at: s.completed_at,
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(log::view_log(&raw, |kept| {
            log::github_sections(kept, &steps)
        }))
    }

    /// Re-run failed jobs in each failed run of the pipeline; when nothing
    /// failed, re-run every finished run (GitLab's retry on a green pipeline).
    pub async fn retry_pipeline(&self, pipeline_id: u64) -> AppResult<()> {
        let runs = self.pipeline_runs(pipeline_id).await?;
        let done: Vec<&GhRun> = runs.iter().filter(|r| r.status == "completed").collect();
        let failed: Vec<&GhRun> = done
            .iter()
            .copied()
            .filter(|r| ci_status(&r.status, r.conclusion.as_deref()) == "failed")
            .collect();
        let (targets, action) = if failed.is_empty() {
            (done, "rerun")
        } else {
            (failed, "rerun-failed-jobs")
        };
        if targets.is_empty() {
            return Err(AppError::Forge(
                "nothing to retry — runs are still in progress".into(),
            ));
        }
        for r in targets {
            self.api(
                &format!("repos/{}/actions/runs/{}/{action}", self.project, r.id),
                &strs(&["-X", "POST"]),
            )
            .await?;
        }
        Ok(())
    }

    pub async fn retry_job(&self, job_id: u64) -> AppResult<()> {
        self.api(
            &format!("repos/{}/actions/jobs/{job_id}/rerun", self.project),
            &strs(&["-X", "POST"]),
        )
        .await
        .map(|_| ())
    }
}

/// `gh issue list` args after `-R <repo>`. gh has no "unassigned" flag, so
/// that one rides along in the search query.
fn issue_list_args(q: &IssueQuery) -> Vec<String> {
    let state = match q.state.as_str() {
        "closed" | "all" => q.state.as_str(),
        _ => "open",
    };
    let mut args = strs(&["--state", state, "--json", ISSUE_FIELDS]);
    args.extend(["--limit".into(), q.limit.to_string()]);
    for l in &q.labels {
        args.extend(["--label".into(), l.clone()]);
    }
    let mut search = q.search.trim().to_string();
    match &q.assignee {
        AssigneeFilter::Any => {}
        AssigneeFilter::Unassigned => search = format!("{search} no:assignee").trim().to_string(),
        AssigneeFilter::Me => args.extend(["--assignee".into(), "@me".into()]),
        AssigneeFilter::User(u) => args.extend(["--assignee".into(), u.clone()]),
    }
    if !search.is_empty() {
        args.extend(["--search".into(), search]);
    }
    args
}

fn strs(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

fn parse<T: for<'de> Deserialize<'de>>(label: &str, json: &str) -> AppResult<T> {
    serde_json::from_str(json).map_err(|e| AppError::Forge(format!("parse {label}: {e}")))
}

fn is_review_thread(id: &str) -> bool {
    id.starts_with("PRRT_")
}

/// The trailing number of the last `…<segment>N` URL `gh` printed:
/// `https://github.com/o/r/pull/12\n` with `/pull/` → 12.
fn number_from_url(out: &str, segment: &str) -> Option<u64> {
    let url = out.lines().rev().find(|l| l.contains(segment))?;
    url.trim().rsplit('/').next()?.parse().ok()
}

/// Map an Actions run/job `status` + `conclusion` onto the GitLab-style
/// vocabulary `ci-status.ts` renders.
fn ci_status(status: &str, conclusion: Option<&str>) -> String {
    match status {
        "completed" => match conclusion.unwrap_or("") {
            "success" | "neutral" => "success",
            "failure" | "timed_out" | "startup_failure" => "failed",
            "cancelled" => "canceled",
            "skipped" | "stale" => "skipped",
            "action_required" => "manual",
            _ => "",
        },
        "in_progress" => "running",
        // queued | waiting | requested | pending
        _ => "pending",
    }
    .to_string()
}

/// Pipeline roll-up across runs, most salient first (mirrors `stageStatus`).
fn rollup(statuses: &[String]) -> String {
    let any = |s: &str| statuses.iter().any(|x| x == s);
    if any("failed") {
        "failed"
    } else if any("running") {
        "running"
    } else if any("pending") {
        "pending"
    } else if any("canceled") {
        "canceled"
    } else if any("manual") {
        "manual"
    } else if statuses.iter().all(|s| s == "success" || s == "skipped") {
        "success"
    } else {
        ""
    }
    .to_string()
}

/// Actions logs prefix every line with an RFC 3339 timestamp
/// (`2024-05-01T12:00:00.1234567Z `). Drop it — it's noise to an agent and
/// eats into the bounded log budget.
fn strip_log_timestamps(log: &str) -> String {
    log.lines()
        .map(|l| {
            let b = l.as_bytes();
            let stamped = b.len() > 20 && b[4] == b'-' && b[10] == b'T';
            match l.find("Z ") {
                Some(i) if stamped && i < 40 => &l[i + 2..],
                _ => l,
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// GitHub's `mergeStateStatus` (+ `reviewDecision` to explain `BLOCKED`),
/// translated to the GitLab `detailed_merge_status` values `MrBar` labels.
fn merge_status(state: Option<&str>, review: Option<&str>) -> Option<String> {
    let s = match state? {
        "CLEAN" | "HAS_HOOKS" | "UNSTABLE" => "mergeable",
        "DIRTY" => "conflict",
        "BEHIND" => "need_rebase",
        "DRAFT" => "draft_status",
        "BLOCKED" => match review {
            Some("REVIEW_REQUIRED") => "not_approved",
            Some("CHANGES_REQUESTED") => "requested_changes",
            _ => "blocked",
        },
        _ => return None, // UNKNOWN: GitHub is still computing it
    };
    Some(s.to_string())
}

// --- raw gh / REST / GraphQL shapes (deserialize-only) ---

#[derive(Deserialize)]
struct GhUser {
    login: String,
}

#[derive(Deserialize)]
struct GhLabel {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhIssue {
    number: u64,
    title: String,
    #[serde(default)]
    body: String,
    state: String,
    #[serde(default)]
    labels: Vec<GhLabel>,
    #[serde(default)]
    assignees: Vec<GhUser>,
    url: String,
    #[serde(default)]
    updated_at: String,
}

impl GhIssue {
    fn normalize(self) -> ForgeIssue {
        ForgeIssue {
            number: self.number,
            title: self.title,
            body: self.body,
            state: normalize_state(&self.state),
            labels: self.labels.into_iter().map(|l| l.name).collect(),
            assignees: self.assignees.into_iter().map(|u| u.login).collect(),
            url: self.url,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPr {
    number: u64,
    title: String,
    head_ref_name: String,
    base_ref_name: String,
    state: String,
    url: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    merge_state_status: Option<String>,
    #[serde(default)]
    review_decision: Option<String>,
}

impl GhPr {
    fn normalize(self) -> ForgeMr {
        ForgeMr {
            number: self.number,
            merge_status: merge_status(
                self.merge_state_status.as_deref(),
                self.review_decision.as_deref(),
            ),
            title: self.title,
            source_branch: self.head_ref_name,
            target_branch: self.base_ref_name,
            state: normalize_state(&self.state),
            url: self.url,
            draft: self.is_draft,
        }
    }
}

#[derive(Deserialize)]
struct GhPrHead {
    head: GhSha,
}

#[derive(Deserialize)]
struct GhSha {
    sha: String,
}

#[derive(Deserialize)]
struct GhRepoSettings {
    #[serde(default)]
    allow_merge_commit: bool,
    #[serde(default)]
    allow_squash_merge: bool,
    #[serde(default)]
    allow_rebase_merge: bool,
}

#[derive(Deserialize)]
struct GhRuns {
    #[serde(default)]
    workflow_runs: Vec<GhRun>,
}

#[derive(Deserialize)]
struct GhRun {
    id: u64,
    /// Workflow name.
    #[serde(default)]
    name: String,
    #[serde(default)]
    head_branch: String,
    head_sha: String,
    status: String,
    conclusion: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    created_at: String,
    head_commit: Option<GhHeadCommit>,
}

#[derive(Deserialize)]
struct GhJobs {
    #[serde(default)]
    jobs: Vec<GhJob>,
}

#[derive(Deserialize)]
struct GhJob {
    id: u64,
    name: String,
    status: String,
    conclusion: Option<String>,
    #[serde(default)]
    run_attempt: u32,
    started_at: Option<String>,
    completed_at: Option<String>,
    #[serde(default)]
    html_url: String,
}

#[derive(Deserialize)]
struct GhJobDetail {
    #[serde(default)]
    steps: Vec<GhStep>,
}

#[derive(Deserialize)]
struct GhStep {
    name: String,
    status: String,
    conclusion: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
}

#[derive(Deserialize)]
struct GhHeadCommit {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct GqlResponse<T> {
    data: Option<T>,
}

#[derive(Deserialize)]
struct GqlNodes<T> {
    nodes: Vec<T>,
}

#[derive(Deserialize)]
struct GqlApproval {
    viewer: GhUser,
    repository: GqlRepo<GqlApprovalPr>,
}

impl GqlApproval {
    /// Node id of the viewer's standing approval, if any.
    fn own_approval(&self) -> Option<String> {
        self.repository
            .pull_request
            .latest_opinionated_reviews
            .nodes
            .iter()
            .find(|r| {
                r.state == "APPROVED"
                    && r.author.as_ref().map(|a| a.login.as_str()) == Some(&self.viewer.login)
            })
            .map(|r| r.id.clone())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlRepo<T> {
    pull_request: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlApprovalPr {
    state: String,
    author: Option<GhUser>,
    latest_opinionated_reviews: GqlNodes<GqlReview>,
}

#[derive(Deserialize)]
struct GqlReview {
    id: String,
    state: String,
    author: Option<GhUser>,
}

#[derive(Deserialize)]
struct GqlThreads {
    repository: GqlRepo<GqlThreadsPr>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlThreadsPr {
    review_threads: GqlNodes<GqlReviewThread>,
    comments: GqlNodes<GqlComment>,
    reviews: GqlNodes<GqlComment>,
}

/// A review thread. The diff anchor (path, line, side) lives on the thread
/// in GitHub's schema — review comments have no `diffSide` — so every note
/// in it gets the thread's position, the way GitLab notes each carry one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlReviewThread {
    id: String,
    is_resolved: bool,
    path: String,
    /// `None` once the line is outdated; fall back to `original_line`.
    line: Option<u32>,
    original_line: Option<u32>,
    diff_side: String,
    comments: GqlNodes<GqlThreadComment>,
}

impl GqlReviewThread {
    fn position(&self) -> ForgePosition {
        let line = self.line.or(self.original_line);
        let (new_line, old_line) = if self.diff_side == "LEFT" {
            (None, line)
        } else {
            (line, None)
        };
        ForgePosition {
            new_path: Some(self.path.clone()),
            new_line,
            old_path: Some(self.path.clone()),
            old_line,
        }
    }

    fn normalize(self) -> ForgeThread {
        let position = self.position();
        ForgeThread {
            id: self.id,
            notes: self
                .comments
                .nodes
                .into_iter()
                .map(|c| c.normalize(position.clone()))
                .collect(),
            resolvable: true,
            resolved: self.is_resolved,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlThreadComment {
    database_id: Option<u64>,
    author: Option<GhUser>,
    body: String,
    created_at: String,
}

impl GqlThreadComment {
    fn normalize(self, position: ForgePosition) -> ForgeNote {
        ForgeNote {
            id: self.database_id.unwrap_or_default(),
            author: self.author.map(|a| a.login).unwrap_or_default(),
            body: self.body,
            position: Some(position),
            created_at: self.created_at,
        }
    }
}

/// An issue comment or a review summary — flat, so a thread of one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlComment {
    id: String,
    database_id: Option<u64>,
    author: Option<GhUser>,
    body: String,
    created_at: String,
}

impl GqlComment {
    fn into_thread(self) -> ForgeThread {
        ForgeThread {
            id: self.id,
            notes: vec![ForgeNote {
                id: self.database_id.unwrap_or_default(),
                author: self.author.map(|a| a.login).unwrap_or_default(),
                body: self.body,
                position: None,
                created_at: self.created_at,
            }],
            resolvable: false,
            resolved: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_list_args_maps_filters() {
        let q = IssueQuery {
            search: "login".into(),
            state: "".into(),
            labels: vec!["bug".into()],
            assignee: AssigneeFilter::Unassigned,
            limit: 20,
        };
        assert_eq!(
            issue_list_args(&q),
            strs(&[
                "--state",
                "open",
                "--json",
                ISSUE_FIELDS,
                "--limit",
                "20",
                "--label",
                "bug",
                "--search",
                "login no:assignee",
            ])
        );
        let q = IssueQuery {
            state: "all".into(),
            assignee: AssigneeFilter::Me,
            limit: 5,
            ..Default::default()
        };
        assert_eq!(
            issue_list_args(&q),
            strs(&[
                "--state",
                "all",
                "--json",
                ISSUE_FIELDS,
                "--limit",
                "5",
                "--assignee",
                "@me"
            ])
        );
    }

    #[test]
    fn ci_status_maps_actions_vocabulary() {
        assert_eq!(ci_status("completed", Some("failure")), "failed");
        assert_eq!(ci_status("completed", Some("timed_out")), "failed");
        assert_eq!(ci_status("completed", Some("success")), "success");
        assert_eq!(ci_status("completed", Some("cancelled")), "canceled");
        assert_eq!(ci_status("completed", Some("skipped")), "skipped");
        assert_eq!(ci_status("in_progress", None), "running");
        assert_eq!(ci_status("queued", None), "pending");
    }

    #[test]
    fn rollup_prefers_failure_then_activity() {
        let s = |xs: &[&str]| xs.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(rollup(&s(&["success", "failed", "running"])), "failed");
        assert_eq!(rollup(&s(&["success", "running"])), "running");
        assert_eq!(rollup(&s(&["success", "skipped"])), "success");
        assert_eq!(rollup(&s(&["success", "canceled"])), "canceled");
    }

    #[test]
    fn merge_status_explains_blocked() {
        assert_eq!(
            merge_status(Some("CLEAN"), None).as_deref(),
            Some("mergeable")
        );
        assert_eq!(
            merge_status(Some("DIRTY"), None).as_deref(),
            Some("conflict")
        );
        assert_eq!(
            merge_status(Some("BLOCKED"), Some("REVIEW_REQUIRED")).as_deref(),
            Some("not_approved")
        );
        assert_eq!(
            merge_status(Some("BLOCKED"), None).as_deref(),
            Some("blocked")
        );
        assert_eq!(merge_status(Some("UNKNOWN"), None), None);
    }

    #[test]
    fn number_from_create_output() {
        assert_eq!(
            number_from_url("https://github.com/o/r/pull/42\n", "/pull/"),
            Some(42)
        );
        assert_eq!(
            number_from_url(
                "Warning: 1 uncommitted change\nhttps://ghe.acme.io/o/r/pull/7\n",
                "/pull/"
            ),
            Some(7)
        );
        assert_eq!(
            number_from_url("https://github.com/o/r/issues/515\n", "/issues/"),
            Some(515)
        );
        assert_eq!(number_from_url("nope", "/pull/"), None);
    }

    #[test]
    fn review_threads_take_position_from_the_thread() {
        // Shape of `list_threads`' GraphQL response: diff anchor on the
        // thread, plain comments under it.
        let json = r#"{"repository":{"pullRequest":{
            "reviewThreads":{"nodes":[{"id":"PRRT_1","isResolved":false,"path":"src/a.rs",
                "line":null,"originalLine":12,"diffSide":"LEFT",
                "comments":{"nodes":[{"databaseId":7,"author":{"login":"kim"},
                    "body":"nit","createdAt":"2026-10-01T00:00:00Z"}]}}]},
            "comments":{"nodes":[{"id":"IC_1","databaseId":8,"author":null,
                "body":"LGTM","createdAt":"2026-10-02T00:00:00Z"}]},
            "reviews":{"nodes":[]}}}}"#;
        let q: GqlThreads = serde_json::from_str(json).unwrap();
        let pr = q.repository.pull_request;
        let t = pr
            .review_threads
            .nodes
            .into_iter()
            .next()
            .unwrap()
            .normalize();
        assert!(t.resolvable && !t.resolved);
        let pos = t.notes[0].position.as_ref().unwrap();
        assert_eq!(pos.old_path.as_deref(), Some("src/a.rs"));
        assert_eq!((pos.old_line, pos.new_line), (Some(12), None));
        let general = pr.comments.nodes.into_iter().next().unwrap().into_thread();
        assert!(!general.resolvable && general.notes[0].position.is_none());
    }

    #[test]
    fn strips_actions_log_timestamps() {
        let log = "2024-05-01T12:00:00.1234567Z ##[group]Run tests\n2024-05-01T12:00:01.0000000Z error: boom\nplain line";
        assert_eq!(
            strip_log_timestamps(log),
            "##[group]Run tests\nerror: boom\nplain line"
        );
    }
}
