//! Pure git-remote-URL parsing → `RemoteInfo { host, owner, repo, kind }`.
//! No I/O — the single unit-tested surface of the forge module. Handles SSH
//! (scp-like), `ssh://…[:port]/…`, and HTTP(S) forms, including GitLab nested
//! groups (`group/subgroup/repo`).

use crate::forge::types::ForgeKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteInfo {
    pub host: String,
    /// Project owner. May contain nested groups for GitLab, e.g. `grp/sub`.
    pub owner: String,
    pub repo: String,
    pub kind: ForgeKind,
}

impl RemoteInfo {
    /// `owner/repo` (owner may include nested groups).
    pub fn project(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

/// Percent-encode per RFC 3986 unreserved set — encodes `/`, spaces, etc.
/// Used both for project ids (`grp/repo` → `grp%2Frepo`) and query values.
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Parse a git remote URL. Returns `None` for anything we can't classify
/// (so callers treat it as "no forge").
pub fn parse_remote(url: &str) -> Option<RemoteInfo> {
    let url = url.trim();

    // (host, path) where path is "owner/.../repo[.git]".
    let (host, path) = if let Some(rest) = url.strip_prefix("git@") {
        // scp-like: git@host:owner/repo.git
        let (host, path) = rest.split_once(':')?;
        (host.to_string(), path.to_string())
    } else if let Some(rest) = url.strip_prefix("ssh://") {
        // ssh://git@host[:port]/owner/repo.git
        let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (hostport, path) = rest.split_once('/')?;
        let host = hostport.split(':').next()?.to_string();
        (host, path.to_string())
    } else if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        // https://[user@]host[:port]/owner/repo.git
        let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (hostport, path) = rest.split_once('/')?;
        let host = hostport.split(':').next()?.to_string();
        (host, path.to_string())
    } else {
        return None;
    };

    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.rsplit_once('/')?;
    if host.is_empty() || owner.is_empty() || repo.is_empty() {
        return None;
    }

    Some(RemoteInfo {
        host: host.clone(),
        owner: owner.to_string(),
        repo: repo.to_string(),
        kind: kind_for_host(&host),
    })
}

fn kind_for_host(host: &str) -> ForgeKind {
    let h = host.to_ascii_lowercase();
    if h == "github.com" || h.contains("github") {
        ForgeKind::Github
    } else if h == "gitlab.com" || h.contains("gitlab") {
        ForgeKind::Gitlab
    } else {
        ForgeKind::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ri(host: &str, owner: &str, repo: &str, kind: ForgeKind) -> RemoteInfo {
        RemoteInfo {
            host: host.into(),
            owner: owner.into(),
            repo: repo.into(),
            kind,
        }
    }

    #[test]
    fn ssh_scp_github() {
        assert_eq!(
            parse_remote("git@github.com:kylewalters18/treehouse.git"),
            Some(ri("github.com", "kylewalters18", "treehouse", ForgeKind::Github))
        );
    }

    #[test]
    fn https_gitlab_no_dotgit() {
        assert_eq!(
            parse_remote("https://gitlab.com/kylewalters/test"),
            Some(ri("gitlab.com", "kylewalters", "test", ForgeKind::Gitlab))
        );
    }

    #[test]
    fn https_gitlab_with_dotgit() {
        assert_eq!(
            parse_remote("https://gitlab.com/kylewalters/test.git"),
            Some(ri("gitlab.com", "kylewalters", "test", ForgeKind::Gitlab))
        );
    }

    #[test]
    fn gitlab_nested_groups() {
        let r = parse_remote("git@gitlab.com:grp/subgrp/repo.git").unwrap();
        assert_eq!(r.owner, "grp/subgrp");
        assert_eq!(r.repo, "repo");
        assert_eq!(r.project(), "grp/subgrp/repo");
        assert_eq!(percent_encode(&r.project()), "grp%2Fsubgrp%2Frepo");
    }

    #[test]
    fn self_managed_gitlab_host() {
        let r = parse_remote("https://gitlab.acme.io/team/app.git").unwrap();
        assert_eq!(r.host, "gitlab.acme.io");
        assert_eq!(r.kind, ForgeKind::Gitlab);
    }

    #[test]
    fn ssh_explicit_port() {
        let r = parse_remote("ssh://git@gitlab.acme.io:2222/team/app.git").unwrap();
        assert_eq!(r.host, "gitlab.acme.io");
        assert_eq!(r.owner, "team");
        assert_eq!(r.repo, "app");
    }

    #[test]
    fn https_with_user() {
        let r = parse_remote("https://oauth2@gitlab.com/kylewalters/test.git").unwrap();
        assert_eq!(r.host, "gitlab.com");
        assert_eq!(r.owner, "kylewalters");
    }

    #[test]
    fn unknown_host_is_unknown_kind() {
        let r = parse_remote("git@git.example.org:team/app.git").unwrap();
        assert_eq!(r.kind, ForgeKind::Unknown);
    }

    #[test]
    fn garbage_is_none() {
        assert_eq!(parse_remote("not a url"), None);
        assert_eq!(parse_remote(""), None);
        assert_eq!(parse_remote("git@github.com:"), None);
        assert_eq!(parse_remote("https://github.com/onlyowner"), None);
    }

    #[test]
    fn percent_encode_slashes_and_spaces() {
        assert_eq!(percent_encode("grp/repo"), "grp%2Frepo");
        assert_eq!(percent_encode("login page"), "login%20page");
        assert_eq!(percent_encode("a-b_c.d~e"), "a-b_c.d~e");
    }
}
