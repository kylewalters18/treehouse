//! Git LFS awareness for the workdir diff.
//!
//! libgit2 runs only its built-in filters, never external drivers like
//! `filter=lfs`. A checked-out LFS file therefore hashes as its smudged
//! content while the tree holds the ~130-byte pointer, so every LFS file looks
//! modified even though `git status` (which runs the clean filter) is clean.
//! We undo that by recomputing the pointer for the workdir file and comparing.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use git2::{Delta, DiffDelta, Repository};
use sha2::{Digest, Sha256};

/// Spec says pointer files are < 1024 bytes; anything larger isn't one.
const MAX_POINTER_BYTES: usize = 1024;
const VERSION_LINE: &str = "version https://git-lfs.github.com/spec/v1";

/// True when `delta` is a Modified LFS file whose workdir content is exactly
/// what the base pointer points at — i.e. a phantom change.
pub fn is_unchanged_lfs(repo: &Repository, delta: &DiffDelta<'_>) -> bool {
    if delta.status() != Delta::Modified {
        return false;
    }
    let (Some(workdir), Some(rel)) = (repo.workdir(), delta.new_file().path()) else {
        return false;
    };
    let Ok(blob) = repo.find_blob(delta.old_file().id()) else {
        return false;
    };
    let Some((oid, size)) = parse_pointer(blob.content()) else {
        return false;
    };
    matches!(sha256_if_size(&workdir.join(rel), size), Some(h) if h == oid)
}

/// `(sha256 hex, size)` from an LFS pointer blob, or None if it isn't one.
fn parse_pointer(bytes: &[u8]) -> Option<(String, u64)> {
    if bytes.len() >= MAX_POINTER_BYTES {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.lines();
    if lines.next()? != VERSION_LINE {
        return None;
    }
    let (mut oid, mut size) = (None, None);
    for line in lines {
        if let Some(h) = line.strip_prefix("oid sha256:") {
            oid = Some(h.to_ascii_lowercase());
        } else if let Some(n) = line.strip_prefix("size ") {
            size = n.parse().ok();
        }
    }
    Some((oid?, size?))
}

/// Hash the file only if its length matches — the cheap reject keeps us from
/// reading large files that were genuinely changed.
fn sha256_if_size(path: &Path, size: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    if file.metadata().ok()?.len() != size {
        return None;
    }
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pointer() {
        let p = format!("{VERSION_LINE}\noid sha256:ABCDEF\nsize 42\n");
        assert_eq!(parse_pointer(p.as_bytes()), Some(("abcdef".into(), 42)));
    }

    #[test]
    fn rejects_non_pointer() {
        assert_eq!(parse_pointer(b"hello\n"), None);
        let no_size = format!("{VERSION_LINE}\noid sha256:abc\n");
        assert_eq!(parse_pointer(no_size.as_bytes()), None);
    }
}
