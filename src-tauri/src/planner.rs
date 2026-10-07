//! Repo planners: one agent session per open repo, shown in the ⌘J popup, for
//! brainstorming and turning decisions into issues and worktrees. The global
//! scratch agent (`crate::scratch`) is the same popup with no repo.
//!
//! A planner never runs in the user's checkout. It gets its own `git clone
//! --shared` of the repo at `<repo>__worktrees/.planner` — beside the
//! worktrees, because that's a place agents' sandboxes already allow (the
//! app config dir under ~/Library is commonly denied, which left the planner
//! unable to read its own code). It's a clone, not a git worktree, so it
//! never appears in `git worktree list` and startup reconciliation never
//! adopts it as a sidebar row; the dot hides it in Finder. Refreshed to
//! `origin/<default>` each time a new session starts (never mid-session). Claude launches with the edit tools
//! disabled and a system prompt saying what it's for; the treehouse MCP
//! server scopes it as `CallerScope::Planner`, so `create_issue` and
//! `create_worktree` target its repo without a `repo` argument.
//!
//! Like scratch, each planner session lives in the ordinary `AgentRegistry`
//! under a synthetic `WorktreeId` that's never in `AppState::worktrees`, so
//! the sidebar and agent board never show it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dashmap::DashMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::AppHandle;
use ts_rs::TS;

use crate::agent::supervisor::{self, AgentRegistry};
use crate::agent::{AgentActivity, AgentBackendKind, AgentEvent, AgentSession};
use crate::storage;
use crate::util::errors::{AppError, AppResult};
use crate::util::ids::{AgentSessionId, WorkspaceId, WorktreeId};
use crate::workspace::Workspace;
use crate::worktree::git_ops;

/// Tools a planner's Claude can't use: it reads code, it doesn't change it.
const DISALLOWED_TOOLS: &[&str] = &["Edit", "MultiEdit", "Write", "NotebookEdit"];

/// What the planner is reading: the ref its checkout was refreshed to.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlannerCheckout {
    /// e.g. `origin/main` (or the local default branch with no remote).
    pub base_ref: String,
    /// Short sha the checkout is at.
    pub sha: String,
    /// Set when the refresh fell back (e.g. couldn't fetch origin).
    pub warning: Option<String>,
}

struct Planner {
    worktree_id: WorktreeId,
    agent: Mutex<Option<AgentSessionId>>,
    checkout: Mutex<Option<PlannerCheckout>>,
}

/// Every open repo's planner, created on first open.
#[derive(Default)]
pub struct Planners {
    by_workspace: DashMap<WorkspaceId, Arc<Planner>>,
}

impl Planners {
    fn entry(&self, ws: WorkspaceId) -> Arc<Planner> {
        self.by_workspace
            .entry(ws)
            .or_insert_with(|| {
                Arc::new(Planner {
                    worktree_id: WorktreeId::new(),
                    agent: Mutex::new(None),
                    checkout: Mutex::new(None),
                })
            })
            .clone()
    }

    /// The repo whose planner owns this synthetic worktree id, if any —
    /// how the MCP layer tells a planner caller apart.
    pub fn workspace_for(&self, worktree_id: WorktreeId) -> Option<WorkspaceId> {
        self.by_workspace
            .iter()
            .find(|e| e.value().worktree_id == worktree_id)
            .map(|e| *e.key())
    }

    /// Hook-derived activity of every planner that has a session.
    pub fn activities(&self, agents: &AgentRegistry) -> Vec<(WorkspaceId, AgentActivity)> {
        self.by_workspace
            .iter()
            .filter(|e| e.value().agent.lock().is_some())
            .map(|e| {
                (
                    *e.key(),
                    agents.activity_for_worktree(e.value().worktree_id),
                )
            })
            .collect()
    }

    /// What `ws`'s planner is reading, once a session has started.
    pub fn checkout(&self, ws: WorkspaceId) -> Option<PlannerCheckout> {
        self.by_workspace.get(&ws)?.checkout.lock().clone()
    }

    /// Kill a closed repo's planner and drop it. Its checkout stays on disk
    /// for next time.
    pub fn forget(&self, agents: &AgentRegistry, ws: WorkspaceId) {
        if let Some((_, p)) = self.by_workspace.remove(&ws) {
            supervisor::kill_for_worktree(agents, p.worktree_id);
        }
    }
}

/// A planner session plus what it's reading.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlannerOpened {
    pub session: AgentSession,
    pub checkout: Option<PlannerCheckout>,
}

/// Attach to `ws`'s running planner, or refresh its checkout and start one
/// (with `prompt` as its first message; ignored when attaching).
/// With `resume` (a past planning conversation, see `history`), the running
/// session — itself resumable later — is replaced by that conversation.
/// Resuming works because the checkout path is stable per repo: Claude
/// reopens a conversation only in the directory it was had in.
#[allow(clippy::too_many_arguments)]
pub async fn open(
    app: &AppHandle,
    planners: &Planners,
    agents: &AgentRegistry,
    ws: &Workspace,
    resume: Option<String>,
    prompt: Option<String>,
    cols: u16,
    rows: u16,
    channel: Channel<AgentEvent>,
) -> AppResult<PlannerOpened> {
    let planner = planners.entry(ws.id);
    let existing = *planner.agent.lock();
    if let Some(id) = existing.filter(|id| supervisor::is_live(agents, *id)) {
        if resume.is_none() {
            return Ok(PlannerOpened {
                session: supervisor::attach(agents, id, channel)?,
                checkout: planner.checkout.lock().clone(),
            });
        }
        supervisor::kill_for_worktree(agents, planner.worktree_id);
    }

    let dir = checkout_dir(&ws.root);
    let checkout = refresh_checkout(&ws.root, &ws.default_branch, &dir).await?;
    let settings = storage::load_settings(app).await.unwrap_or_default();
    let backend = settings.default_agent_backend;
    let mut argv = crate::mcp::split_command(settings.agent_commands.for_backend(backend));
    if backend == AgentBackendKind::ClaudeCode {
        argv.extend(claude_planner_flags(&repo_name(&ws.root), &checkout));
    }

    let session = supervisor::launch(
        app,
        agents,
        planner.worktree_id,
        dir,
        backend,
        Some(argv),
        prompt,
        resume,
        cols,
        rows,
        Some(channel),
    )?;
    *planner.agent.lock() = Some(session.id);
    *planner.checkout.lock() = Some(checkout.clone());
    Ok(PlannerOpened {
        session,
        checkout: Some(checkout),
    })
}

fn repo_name(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string())
}

/// `<repo>__worktrees/.planner`. A dot name can't collide with a worktree:
/// worktree directories are slugified branch names, which never start with
/// a dot.
pub fn checkout_dir(repo_root: &Path) -> PathBuf {
    git_ops::worktrees_root_for(repo_root).join(".planner")
}

/// Bring the planner's checkout to the repo's latest `origin/<default>`.
/// Fetches origin first (best-effort — offline falls back to what was last
/// fetched), then mirrors that ref into the shared clone and checks it out
/// detached, discarding anything left over from the previous session.
async fn refresh_checkout(
    repo_root: &Path,
    default_branch: &str,
    dir: &Path,
) -> AppResult<PlannerCheckout> {
    let mut warning = None;
    let fetch = git_ops::git(repo_root, ["fetch", "--quiet", "origin", default_branch]);
    match tokio::time::timeout(std::time::Duration::from_secs(60), fetch).await {
        Ok(Ok(_)) => {}
        Ok(Err(_)) | Err(_) => {
            warning = Some(format!(
                "couldn't fetch origin — reading the last-fetched origin/{default_branch}"
            ))
        }
    }

    let remote_ref = format!("refs/remotes/origin/{default_branch}");
    let (source_ref, base_ref) = if git_ops::rev_parse(repo_root, &remote_ref).await.is_ok() {
        (remote_ref, format!("origin/{default_branch}"))
    } else {
        warning = Some(format!(
            "no origin/{default_branch} — reading local {default_branch}"
        ));
        (
            format!("refs/heads/{default_branch}"),
            default_branch.to_string(),
        )
    };

    if !dir.join(".git").exists() {
        let parent = dir
            .parent()
            .ok_or_else(|| AppError::Unknown("planner dir has no parent".into()))?;
        std::fs::create_dir_all(parent)?;
        // `--shared` borrows the repo's object store: instant, no copy.
        git_ops::git(
            parent,
            [
                "clone".as_ref(),
                "--shared".as_ref(),
                "--no-checkout".as_ref(),
                "--quiet".as_ref(),
                repo_root.as_os_str(),
                dir.as_os_str(),
            ],
        )
        .await?;
    }
    git_ops::git(
        dir,
        [
            "fetch".as_ref(),
            "--quiet".as_ref(),
            "--no-tags".as_ref(),
            repo_root.as_os_str(),
            std::ffi::OsStr::new(&source_ref),
        ],
    )
    .await?;
    git_ops::git(
        dir,
        ["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"],
    )
    .await?;
    git_ops::git(dir, ["clean", "-fdq"]).await?;
    let sha = git_ops::git(dir, ["rev-parse", "--short", "HEAD"])
        .await?
        .trim()
        .to_string();
    Ok(PlannerCheckout {
        base_ref,
        sha,
        warning,
    })
}

/// How many commits `ws`'s base ref has gained since the planner's checkout
/// was refreshed — what the popup's "new commits on origin" badge shows.
/// Fetches origin first (best-effort, like `refresh_checkout`). `None` before
/// the planner's first session.
pub async fn commits_behind(planners: &Planners, ws: &Workspace) -> AppResult<Option<u32>> {
    let Some(checkout) = planners.checkout(ws.id) else {
        return Ok(None);
    };
    Ok(Some(
        count_behind(&ws.root, &ws.default_branch, &checkout).await?,
    ))
}

async fn count_behind(
    repo_root: &Path,
    default_branch: &str,
    checkout: &PlannerCheckout,
) -> AppResult<u32> {
    if checkout.base_ref.starts_with("origin/") {
        let fetch = git_ops::git(repo_root, ["fetch", "--quiet", "origin", default_branch]);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(30), fetch).await;
    }
    let range = format!("{}..{}", checkout.sha, checkout.base_ref);
    let out = git_ops::git(repo_root, ["rev-list", "--count", range.as_str()]).await?;
    out.trim()
        .parse()
        .map_err(|_| AppError::Unknown(format!("unexpected rev-list output: {out}")))
}

/// Extra Claude flags for a planner: no edit tools, and a system prompt
/// saying where it is and how to turn plans into work. Every flag takes a
/// following option (never the end of argv), so the variadic
/// `--disallowedTools` can't swallow anything.
fn claude_planner_flags(repo: &str, checkout: &PlannerCheckout) -> Vec<String> {
    let mut out = vec!["--disallowedTools".to_string()];
    out.extend(DISALLOWED_TOOLS.iter().map(|t| t.to_string()));
    out.push("--append-system-prompt".into());
    out.push(format!(
        "You are the treehouse planner for the `{repo}` repo. Your working directory is a \
         disposable, read-only copy of {base} at {sha} — not the user's checkout, and not where \
         work happens. Read the code freely to plan; you cannot edit files. Turn decisions into \
         work with the treehouse MCP tools: create_issue to file an issue, create_worktree with \
         `issue` to start an agent on one (say in `prompt` to commit and call create_pr if the \
         user wants a PR).",
        base = checkout.base_ref,
        sha = checkout.sha,
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkout_sits_beside_the_worktrees() {
        assert_eq!(
            checkout_dir(Path::new("/code/treehouse")),
            PathBuf::from("/code/treehouse__worktrees/.planner")
        );
    }

    #[tokio::test]
    async fn reconcile_never_adopts_the_planner_checkout() {
        let repo = crate::test_support::TempRepo::new();
        let state = crate::state::AppState::new();
        let ws_id = crate::test_support::workspace_fixture(&state, &repo.root).id;
        refresh_checkout(&repo.root, "main", &checkout_dir(&repo.root))
            .await
            .unwrap();
        crate::worktree::reconcile(ws_id, &state).await.unwrap();
        assert!(state
            .worktrees
            .iter()
            .all(|e| !e.value().path.ends_with(".planner")));
    }

    #[test]
    fn planner_flags_disable_edits_and_end_on_an_option_value() {
        let c = PlannerCheckout {
            base_ref: "origin/main".into(),
            sha: "84ae864".into(),
            warning: None,
        };
        let flags = claude_planner_flags("treehouse", &c);
        assert_eq!(
            &flags[..5],
            [
                "--disallowedTools",
                "Edit",
                "MultiEdit",
                "Write",
                "NotebookEdit"
            ]
        );
        assert_eq!(flags[5], "--append-system-prompt");
        assert!(flags[6].contains("origin/main at 84ae864"));
        assert_eq!(flags.len(), 7);
    }

    #[tokio::test]
    async fn refresh_checkout_mirrors_the_default_branch_detached() {
        let repo = crate::test_support::TempRepo::new();
        // Inside the fixture's tempdir, so it's cleaned up with it.
        let dir = checkout_dir(&repo.root);
        let c = refresh_checkout(&repo.root, "main", &dir).await.unwrap();
        // No origin in the fixture → falls back to the local default branch.
        assert_eq!(c.base_ref, "main");
        assert!(c.warning.is_some());
        assert_eq!(git_ops::rev_parse(&dir, "HEAD").await.unwrap(), repo.head());
        // A new commit shows up on the next refresh, and leftovers from the
        // previous session are discarded.
        std::fs::write(dir.join("scratch.txt"), "x").unwrap();
        repo.write("NEW.md", "new\n");
        let new_head = repo.commit_all("second");
        refresh_checkout(&repo.root, "main", &dir).await.unwrap();
        assert_eq!(git_ops::rev_parse(&dir, "HEAD").await.unwrap(), new_head);
        assert!(!dir.join("scratch.txt").exists());
        assert!(dir.join("NEW.md").exists());
    }

    #[tokio::test]
    async fn count_behind_counts_commits_since_the_checkout() {
        let repo = crate::test_support::TempRepo::new();
        let dir = checkout_dir(&repo.root);
        let c = refresh_checkout(&repo.root, "main", &dir).await.unwrap();
        assert_eq!(count_behind(&repo.root, "main", &c).await.unwrap(), 0);
        repo.commit_file("a.md", "a\n", "one");
        repo.commit_file("b.md", "b\n", "two");
        assert_eq!(count_behind(&repo.root, "main", &c).await.unwrap(), 2);
    }
}
