//! Workspace-root resolution for LSP `initialize` params.
//!
//! Walks upward from `file_path` toward `worktree_root`, returning the
//! first ancestor that contains any of the language's `root_markers`.
//! Falls back to `worktree_root` if no marker is found. Matches the
//! common LSP client convention (see nvim-lspconfig, VSCode extensions).

use std::path::{Path, PathBuf};

pub fn resolve(file_path: &Path, worktree_root: &Path, markers: &[String]) -> PathBuf {
    let start_dir: &Path = if file_path.is_file() {
        file_path.parent().unwrap_or(worktree_root)
    } else {
        file_path
    };

    let worktree_root = worktree_root.to_path_buf();
    let mut cur = start_dir.to_path_buf();

    loop {
        for m in markers {
            if cur.join(m).exists() {
                return cur;
            }
        }
        if cur == worktree_root {
            break;
        }
        match cur.parent() {
            Some(p) => cur = p.to_path_buf(),
            None => break,
        }
    }
    worktree_root
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn finds_marker_in_ancestor() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let pkg = root.join("packages/foo");
        fs::create_dir_all(&pkg).unwrap();
        fs::write(root.join("Cargo.toml"), "").unwrap();
        let file = pkg.join("src/main.rs");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "").unwrap();

        let got = resolve(&file, root, &["Cargo.toml".into()]);
        assert_eq!(got, root);
    }

    #[test]
    fn prefers_nearest_marker() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let inner = root.join("inner");
        fs::create_dir_all(&inner).unwrap();
        fs::write(root.join("Cargo.toml"), "").unwrap();
        fs::write(inner.join("Cargo.toml"), "").unwrap();
        let file = inner.join("src/lib.rs");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "").unwrap();

        let got = resolve(&file, root, &["Cargo.toml".into()]);
        assert_eq!(got, inner);
    }

    #[test]
    fn falls_back_to_worktree_root_when_no_marker() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let file = root.join("src/lib.rs");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "").unwrap();

        let got = resolve(&file, root, &["NOPE.toml".into()]);
        assert_eq!(got, root);
    }
}
