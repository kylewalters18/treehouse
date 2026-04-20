use std::path::{Path, PathBuf};

use git2::Repository;

use crate::util::errors::{AppError, AppResult};

/// Walk up from `start` to find the containing git repo's workdir.
pub fn discover_root(start: &Path) -> AppResult<PathBuf> {
    let repo = Repository::discover(start)
        .map_err(|_| AppError::NotAGitRepo(start.display().to_string()))?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::NotAGitRepo("bare repository".into()))?;
    Ok(workdir.to_path_buf())
}

/// Detect the repo's default branch: prefer `refs/remotes/origin/HEAD`, then
/// common names (`main`, `master`), then give up and return current HEAD.
pub fn detect_default_branch(root: &Path) -> AppResult<String> {
    let repo = Repository::open(root)?;

    if let Ok(head_ref) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(name) = head_ref
            .symbolic_target()
            .and_then(|t| t.strip_prefix("refs/remotes/origin/"))
        {
            return Ok(name.to_string());
        }
    }

    for candidate in ["main", "master"] {
        if repo
            .find_branch(candidate, git2::BranchType::Local)
            .is_ok()
        {
            return Ok(candidate.to_string());
        }
    }

    let head = repo.head()?;
    Ok(head
        .shorthand()
        .unwrap_or("HEAD")
        .to_string())
}
