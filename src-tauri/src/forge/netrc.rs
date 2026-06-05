//! Per-host token lookup from `~/.netrc` — the standard, multi-host credential
//! file `curl`/`git` already use. Each repo's remote host maps to its own
//! `machine` entry, so gitlab.com and a self-managed instance can each carry a
//! distinct token. The entry's `password` is treated as the GitLab PAT.
//!
//! ```text
//! machine gitlab.com      login oauth2 password glpat-aaa
//! machine gitlab.acme.io  login oauth2 password glpat-bbb
//! ```

use std::path::PathBuf;

/// The token (password) for `host` from `~/.netrc`, or `None` if there's no
/// netrc, no matching `machine`, or no password on it.
pub fn token_for_host(host: &str) -> Option<String> {
    let path: PathBuf = PathBuf::from(std::env::var_os("HOME")?).join(".netrc");
    let content = std::fs::read_to_string(path).ok()?;
    parse_token(&content, host)
}

/// Minimal netrc parse: tokens are whitespace-separated `key value` pairs,
/// grouped under `machine <name>` until the next `machine`/`default`.
fn parse_token(content: &str, host: &str) -> Option<String> {
    let mut it = content.split_whitespace().peekable();
    while let Some(tok) = it.next() {
        if tok != "machine" {
            continue;
        }
        let machine = match it.next() {
            Some(m) => m,
            None => break,
        };
        let matches = machine.eq_ignore_ascii_case(host);
        let mut password: Option<String> = None;
        while let Some(&next) = it.peek() {
            if next == "machine" || next == "default" {
                break;
            }
            match it.next() {
                Some("password") => password = it.next().map(str::to_string),
                Some("login") | Some("account") => {
                    it.next();
                }
                _ => {} // stray token; ignore
            }
        }
        if matches {
            if let Some(p) = password {
                return Some(p);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::parse_token;

    const SAMPLE: &str = "machine gitlab.com login oauth2 password glpat-aaa\n\
                          machine gitlab.acme.io\n  login oauth2\n  password glpat-bbb\n\
                          machine github.com login me password ghp-zzz\n";

    #[test]
    fn picks_per_host_token() {
        assert_eq!(parse_token(SAMPLE, "gitlab.com").as_deref(), Some("glpat-aaa"));
        assert_eq!(parse_token(SAMPLE, "gitlab.acme.io").as_deref(), Some("glpat-bbb"));
        assert_eq!(parse_token(SAMPLE, "github.com").as_deref(), Some("ghp-zzz"));
    }

    #[test]
    fn missing_host_is_none() {
        assert_eq!(parse_token(SAMPLE, "gitlab.other.io"), None);
        assert_eq!(parse_token("", "gitlab.com"), None);
    }

    #[test]
    fn case_insensitive_host() {
        assert_eq!(parse_token(SAMPLE, "GitLab.com").as_deref(), Some("glpat-aaa"));
    }
}
