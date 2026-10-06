//! Resumable Kiro conversations, read straight from Kiro's own store.
//!
//! Unlike Claude (see `agent::history`), Kiro has no hooks to tell us a
//! conversation's id, but it keeps one `<id>.json` per conversation under
//! `<KIRO_HOME>/sessions/cli/` with the directory it ran in, its title (the
//! first prompt) and timestamps. `kiro-cli chat --resume-id <id>` reopens
//! one. So nothing is recorded here: the list is the files whose `cwd` is
//! the worktree. Shadow homes (see `mcp::kiro`) symlink `sessions` back to
//! the real home, so treehouse-launched sessions land there too.
//!
//! `kiro-cli chat --list-sessions` would give the same list, but it signs in
//! first (and opens a browser when logged out), which a poll can't do.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

/// Newest conversations past this count aren't listed, per worktree.
const MAX: usize = 20;
const MESSAGE_MAX: usize = 2000;

#[derive(Debug, Clone, PartialEq)]
pub struct KiroSession {
    pub id: String,
    pub title: Option<String>,
    pub last_message: Option<String>,
    pub started_at: u64,
    pub last_active_at: u64,
}

#[derive(Deserialize)]
struct SessionFile {
    session_id: String,
    cwd: PathBuf,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    session_state: Option<Value>,
}

/// `<KIRO_HOME>/sessions/cli`, or `None` when there's no home to look in.
pub fn sessions_dir() -> Option<PathBuf> {
    crate::mcp::kiro_real_home().map(|h| h.join("sessions").join("cli"))
}

/// Conversations that ran in `cwd`, newest first. Ones that never got a
/// prompt (no title) are skipped: there's nothing to resume.
pub fn list_in(dir: &Path, cwd: &Path) -> Vec<KiroSession> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<KiroSession> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| std::fs::read(&p).ok())
        .filter_map(|b| serde_json::from_slice::<SessionFile>(&b).ok())
        .filter(|f| f.cwd == cwd)
        .filter_map(to_session)
        .collect();
    out.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    out.truncate(MAX);
    out
}

fn to_session(f: SessionFile) -> Option<KiroSession> {
    let title = f
        .title
        .as_deref()
        .and_then(|t| first_line(t, MESSAGE_MAX))?;
    if !super::history::is_valid_session_id(&f.session_id) {
        return None;
    }
    let started_at = parse_rfc3339_ms(&f.created_at)?;
    Some(KiroSession {
        last_message: f.session_state.as_ref().and_then(last_reply),
        last_active_at: parse_rfc3339_ms(&f.updated_at).unwrap_or(started_at),
        started_at,
        title: Some(title),
        id: f.session_id,
    })
}

/// Text of the assistant's reply ending the latest turn.
fn last_reply(state: &Value) -> Option<String> {
    let turns = state
        .pointer("/conversation_metadata/user_turn_metadatas")?
        .as_array()?;
    let content = turns.last()?.pointer("/result/Ok/content")?.as_array()?;
    let text = content
        .iter()
        .rev()
        .filter(|c| c.get("kind").and_then(Value::as_str) == Some("text"))
        .find_map(|c| c.get("data").and_then(Value::as_str))?;
    first_line(text, MESSAGE_MAX)
}

fn first_line(s: &str, max: usize) -> Option<String> {
    let line = s.lines().map(str::trim).find(|l| !l.is_empty())?;
    if line.chars().count() <= max {
        return Some(line.to_string());
    }
    let mut out: String = line.chars().take(max).collect();
    out.push('…');
    Some(out)
}

/// Milliseconds since the epoch for a UTC RFC 3339 timestamp, the only
/// form Kiro writes (`2026-10-06T22:14:13.928418Z`).
fn parse_rfc3339_ms(s: &str) -> Option<u64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.splitn(3, ':').map(|p| p.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
    let ms: i64 = format!("{frac:0<3}").get(..3)?.parse().ok()?;
    // Days from civil (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hh * 3600 + mm * 60 + ss;
    u64::try_from(secs * 1000 + ms).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_kiro_timestamps() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_ms("2026-10-06T22:14:13.928418Z"),
            Some(1_791_324_853_928)
        );
        assert_eq!(parse_rfc3339_ms("2026-10-06T22:14:13+02:00"), None);
    }

    fn write(dir: &Path, id: &str, cwd: &str, title: Option<&str>, updated: &str) {
        let body = json!({
            "session_id": id,
            "cwd": cwd,
            "created_at": "2026-10-06T22:00:00Z",
            "updated_at": updated,
            "title": title,
            "session_state": { "conversation_metadata": { "user_turn_metadatas": [
                { "result": { "Ok": { "content": [
                    { "kind": "text", "data": "first reply" }
                ] } } },
                { "result": { "Ok": { "content": [
                    { "kind": "toolUse", "data": {} },
                    { "kind": "text", "data": "\nDone! Made the worktree.\nMore." }
                ] } } }
            ] } }
        });
        std::fs::write(dir.join(format!("{id}.json")), body.to_string()).unwrap();
    }

    #[test]
    fn lists_titled_sessions_in_cwd_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        write(
            d,
            "a-1",
            "/r__worktrees/a",
            Some("fix it"),
            "2026-10-06T22:01:00Z",
        );
        write(
            d,
            "a-2",
            "/r__worktrees/a",
            Some("add tests\nplease"),
            "2026-10-06T22:05:00Z",
        );
        write(d, "a-3", "/r__worktrees/a", None, "2026-10-06T22:09:00Z");
        write(
            d,
            "b-1",
            "/r__worktrees/b",
            Some("other"),
            "2026-10-06T22:09:00Z",
        );
        std::fs::write(d.join("a-1.jsonl"), "{}").unwrap();
        std::fs::write(d.join("junk.json"), "not json").unwrap();

        let got = list_in(d, Path::new("/r__worktrees/a"));
        let ids: Vec<_> = got.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["a-2", "a-1"]);
        assert_eq!(got[0].title.as_deref(), Some("add tests"));
        assert_eq!(
            got[0].last_message.as_deref(),
            Some("Done! Made the worktree.")
        );
        assert!(got[0].last_active_at > got[0].started_at);
    }

    #[test]
    fn missing_dir_lists_nothing() {
        assert!(list_in(Path::new("/nonexistent/kiro"), Path::new("/x")).is_empty());
    }
}
