//! Shared fixtures for Rust tests. Only compiled in test builds.
//!
//! Gives integration-style tests a real git repo + a hand-built `AppState`
//! to exercise `git_ops`, `worktree::manager`, and `diff::compute` end-to-end
//! without Tauri, PTYs, or spawned agents.

use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;

use crate::state::AppState;
use crate::util::ids::WorkspaceId;
use crate::workspace::Workspace;

/// A throwaway git repo on disk. The repo lives *inside* a wrapping tempdir
/// so sibling worktrees created at `<repo>__worktrees/` also land inside the
/// tempdir and get cleaned up on drop.
pub struct TempRepo {
    _dir: TempDir,
    pub root: PathBuf,
}

impl TempRepo {
    /// Init a repo on `main` with one initial commit (`README.md`).
    pub fn new() -> Self {
        let dir = TempDir::new().expect("temp dir");
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).expect("mkdir repo");
        run_git(&root, &["init", "-b", "main", "-q"]);
        // Isolate git config from the host user.
        run_git(&root, &["config", "user.email", "test@example.com"]);
        run_git(&root, &["config", "user.name", "Test"]);
        run_git(&root, &["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("README.md"), "# test\n").expect("write README");
        run_git(&root, &["add", "README.md"]);
        run_git(&root, &["commit", "-q", "-m", "initial"]);
        Self { _dir: dir, root }
    }

    pub fn head(&self) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(["rev-parse", "HEAD"])
            .output()
            .expect("rev-parse");
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    pub fn write(&self, rel: &str, content: &str) {
        let p = self.root.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("mkdir -p");
        }
        std::fs::write(p, content).expect("write");
    }

    pub fn commit_all(&self, msg: &str) -> String {
        run_git(&self.root, &["add", "-A"]);
        run_git(&self.root, &["commit", "-q", "-m", msg]);
        self.head()
    }

    /// Add + commit a single file in one step; returns the commit sha.
    pub fn commit_file(&self, rel: &str, content: &str, msg: &str) -> String {
        self.write(rel, content);
        run_git(&self.root, &["add", rel]);
        run_git(&self.root, &["commit", "-q", "-m", msg]);
        self.head()
    }
}

fn run_git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .status()
        .expect("spawn git");
    assert!(status.success(), "git {args:?} failed in {}", root.display());
}

/// Register a fake workspace pointing at `root` into the given AppState, using
/// `main` as the default branch. Returns the inserted Workspace.
pub fn workspace_fixture(state: &AppState, root: &Path) -> Workspace {
    let ws = Workspace {
        id: WorkspaceId::new(),
        root: root.to_path_buf(),
        default_branch: "main".to_string(),
    };
    state.workspaces.insert(ws.id, ws.clone());
    ws
}
