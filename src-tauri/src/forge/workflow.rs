//! The issue → worktree → PR workflow, shared by the renderer's commands and
//! the MCP tools so a person in the New Worktree dialog and an agent over MCP
//! run the same steps: start a worktree from an issue (link, assign, seed
//! prompt), and open a PR/MR that closes the linked issue.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter};

use crate::forge::{Forge, ForgeIssue, ForgeMr, IssueStart, IssueStartResult};
use crate::ipc::events;
use crate::state::AppState;
use crate::storage;
use crate::util::errors::{AppError, AppResult};
use crate::util::ids::WorkspaceId;
use crate::worktree::git_ops;

/// An issue as an agent's task: title, link, description, labels. The single
/// formatter for both the create-from-issue seed and the issue chip's
/// "Send to agent".
pub fn issue_prompt(issue: &ForgeIssue) -> String {
    let mut parts = vec![
        format!("Work on issue #{}: {}", issue.number, issue.title),
        issue.url.clone(),
    ];
    let body = issue.body.trim();
    if !body.is_empty() {
        parts.push(body.to_string());
    }
    if !issue.labels.is_empty() {
        parts.push(format!("Labels: {}", issue.labels.join(", ")));
    }
    parts.join("\n\n") + "\n"
}

/// Link (or with `None`, unlink) a worktree to an issue, and tell the
/// renderer so the sidebar badge / issue chip / PR form update — including
/// when an agent did it over MCP.
pub async fn set_issue_link(
    app: &AppHandle,
    worktree_path: &Path,
    issue: Option<u64>,
) -> AppResult<BTreeMap<PathBuf, u64>> {
    let map = storage::set_issue_link(app, &worktree_path.to_path_buf(), issue).await?;
    let _ = app.emit(&events::issue_links_changed(), ());
    Ok(map)
}

/// The issue a worktree is linked to, if any.
pub async fn linked_issue(app: &AppHandle, worktree_path: &Path) -> Option<u64> {
    storage::list_issue_links(app)
        .await
        .ok()?
        .get(worktree_path)
        .copied()
}

/// Run the create-from-issue extras on a worktree that already exists:
/// store the link, self-assign, and build the seed prompt. Each step is
/// best-effort — a failure becomes a warning, never a failed create.
pub async fn start_from_issue(
    app: &AppHandle,
    forge: &Forge,
    worktree_path: &Path,
    start: &IssueStart,
) -> IssueStartResult {
    let n = start.number;
    let mut warnings = Vec::new();
    if start.link {
        if let Err(e) = set_issue_link(app, worktree_path, Some(n)).await {
            warnings.push(format!("couldn't link #{n}: {e}"));
        }
    }
    if start.assign {
        if let Err(e) = forge.set_issue_assignee(n, true).await {
            warnings.push(format!("couldn't assign #{n}: {e}"));
        }
    }
    let prompt = match forge.get_issue(n).await {
        Ok(issue) => Some(issue_prompt(&issue)),
        Err(e) => {
            warnings.push(format!("couldn't read #{n}: {e}"));
            None
        }
    };
    IssueStartResult { prompt, warnings }
}

/// Make `body` carry exactly one `Closes #n` line when `close` is set, and
/// none when it isn't. A line the user already wrote (any case) is kept in
/// place rather than duplicated.
pub fn with_closes_line(body: &str, n: u64, close: bool) -> String {
    let line = format!("Closes #{n}");
    let is_line = |l: &str| l.trim().eq_ignore_ascii_case(&line);
    let present = body.lines().any(is_line);
    if close {
        if present {
            body.trim().to_string()
        } else if body.trim().is_empty() {
            line
        } else {
            format!("{line}\n\n{}", body.trim())
        }
    } else {
        body.lines()
            .filter(|l| !is_line(l))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string()
    }
}

/// Push a worktree's branch and open an MR/PR for it, targeting the branch it
/// was forked from. Refuses — without pushing — when the branch has no commits
/// beyond its base, naming uncommitted changes if there are any: treehouse
/// never commits on anyone's behalf. With `close_issue`, a linked worktree's
/// PR gets a `Closes #n` line.
#[allow(clippy::too_many_arguments)]
pub async fn create_pr(
    app: &AppHandle,
    state: &AppState,
    forge: &Forge,
    root: &Path,
    workspace_id: WorkspaceId,
    branch: &str,
    title: &str,
    body: &str,
    draft: bool,
    close_issue: bool,
) -> AppResult<ForgeMr> {
    let wt = state
        .worktrees
        .iter()
        .find(|e| e.value().workspace_id == workspace_id && e.value().branch == branch)
        .map(|e| e.value().clone());
    // Target the branch this worktree was forked from (chosen at create time),
    // falling back to the repo default for branches we don't track.
    let target = match &wt {
        Some(w) => w.base_branch.clone(),
        None => state
            .workspaces
            .get(&workspace_id)
            .map(|e| e.value().default_branch.clone())
            .ok_or_else(|| AppError::Unknown(format!("unknown workspace: {workspace_id}")))?,
    };

    if let Some(w) = &wt {
        let base = if w.base_ref.is_empty() {
            &target
        } else {
            &w.base_ref
        };
        if git_ops::commits_ahead(root, base, branch)
            .await
            .unwrap_or(1)
            == 0
        {
            let dirty = git_ops::has_changes(&w.path).await.unwrap_or(false);
            return Err(AppError::Forge(if dirty {
                format!("{branch} has no commits ahead of {target} — commit the uncommitted changes first")
            } else {
                format!("{branch} has no commits ahead of {target} — nothing to open a PR for")
            }));
        }
    }

    let linked = match &wt {
        Some(w) => linked_issue(app, &w.path).await,
        None => None,
    };
    let body = match linked {
        Some(n) => with_closes_line(body, n, close_issue),
        None => body.trim().to_string(),
    };

    git_ops::push_branch(root, branch).await?;
    let mr = forge
        .create_mr(branch, &target, title, &body, draft)
        .await?;
    let _ = app.emit(&events::mr_changed(workspace_id), branch.to_string());
    Ok(mr)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue() -> ForgeIssue {
        ForgeIssue {
            number: 57,
            title: "Diff pane loses scroll".into(),
            body: "  Jumps to top on recompute.  ".into(),
            state: "open".into(),
            labels: vec!["bug".into(), "diff".into()],
            assignees: vec![],
            url: "https://github.com/o/r/issues/57".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn issue_prompt_has_title_link_body_labels() {
        assert_eq!(
            issue_prompt(&issue()),
            "Work on issue #57: Diff pane loses scroll\n\nhttps://github.com/o/r/issues/57\n\n\
             Jumps to top on recompute.\n\nLabels: bug, diff\n"
        );
    }

    #[test]
    fn issue_prompt_omits_empty_body_and_labels() {
        let i = ForgeIssue {
            body: " ".into(),
            labels: vec![],
            ..issue()
        };
        assert_eq!(
            issue_prompt(&i),
            "Work on issue #57: Diff pane loses scroll\n\nhttps://github.com/o/r/issues/57\n"
        );
    }

    #[test]
    fn closes_line_added_once() {
        assert_eq!(with_closes_line("", 7, true), "Closes #7");
        assert_eq!(
            with_closes_line("Fixes the thing.", 7, true),
            "Closes #7\n\nFixes the thing."
        );
        assert_eq!(
            with_closes_line("Fixes the thing.\n\ncloses #7", 7, true),
            "Fixes the thing.\n\ncloses #7"
        );
    }

    #[test]
    fn closes_line_removed_when_not_closing() {
        assert_eq!(
            with_closes_line("Closes #7\n\nFixes it.", 7, false),
            "Fixes it."
        );
        // Another issue's line is the user's business.
        assert_eq!(with_closes_line("Closes #8", 7, false), "Closes #8");
    }
}
