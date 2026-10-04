//! Resumable Claude Code conversations, per worktree.
//!
//! Claude keeps every transcript on disk itself and `claude --resume <id>`
//! reopens one in the same directory, so all we remember is which
//! conversation ids belong to which worktree, plus enough text to label
//! them. The id comes from the `session_id` field of Claude's hook payloads
//! (see `agent::hooks`); a record is written on the first
//! `UserPromptSubmit` and refreshed on every turn, so it survives a crash
//! as well as a closed tab.
//!
//! Records are keyed by worktree **path**: `WorktreeId`s don't survive a
//! restart. Only sessions treehouse launched show up here.
//!
//! File: `<app_config_dir>/agent_history.json`.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::util::ids::AgentSessionId;

pub const HISTORY_FILE: &str = "agent_history.json";

/// Oldest records past this count are dropped, per worktree.
const PER_WORKTREE_MAX: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Record {
    claude_session_id: String,
    worktree_path: PathBuf,
    title: Option<String>,
    /// First line of the most recent prompt, so a resumed agent's board
    /// card can show what it was last asked. Absent in older files.
    #[serde(default)]
    last_prompt: Option<String>,
    /// Claude Code's generated title for the conversation.
    #[serde(default)]
    ai_title: Option<String>,
    last_message: Option<String>,
    started_at: u64,
    last_active_at: u64,
}

/// The text of a conversation's latest turn, as the hooks last saw it.
/// Also what a resumed agent's board card is seeded with.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LastTurn {
    pub ai_title: Option<String>,
    pub prompt: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct HistoryFile {
    items: Vec<Record>,
}

/// One resumable conversation, as the agent pane's history menu shows it.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentHistoryEntry {
    pub claude_session_id: String,
    /// Claude Code's generated title, or the first prompt when there's none
    /// yet (records from before titles were read, or a conversation that
    /// ended before Claude named it).
    pub title: Option<String>,
    /// Claude's most recent reply.
    pub last_message: Option<String>,
    #[ts(type = "number")]
    pub started_at: u64,
    #[ts(type = "number")]
    pub last_active_at: u64,
    /// The running agent that has this conversation open, if any.
    pub live_agent_id: Option<AgentSessionId>,
}

#[derive(Default)]
pub struct AgentHistory {
    /// `None` until `load` runs at startup; until then nothing is saved.
    path: Mutex<Option<PathBuf>>,
    records: Mutex<Vec<Record>>,
}

impl AgentHistory {
    /// Read the history file and remember where to write it back. A missing
    /// or unreadable file starts empty.
    pub fn load(&self, path: PathBuf) {
        let file: HistoryFile = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        *self.records.lock() = file.items;
        *self.path.lock() = Some(path);
    }

    /// Fold one turn of a conversation into the history. `resumed_from` is
    /// the id the agent was launched with `--resume`; if Claude reports a
    /// different id, the old record is carried over to the new one so the
    /// conversation doesn't show up twice. `first_prompt` names a new record.
    pub fn observe(
        &self,
        worktree_path: &Path,
        resumed_from: Option<&str>,
        claude_session_id: &str,
        first_prompt: Option<&str>,
        turn: &LastTurn,
        now_ms: u64,
    ) {
        let mut records = self.records.lock();
        let before = records.clone();
        upsert(
            &mut records,
            worktree_path,
            resumed_from,
            claude_session_id,
            first_prompt,
            turn,
            now_ms,
        );
        if *records != before {
            self.save(&records);
        }
    }

    /// Records for one worktree, newest first. `live_agent_id` is left for
    /// the caller to fill in.
    pub fn list_for(&self, worktree_path: &Path) -> Vec<AgentHistoryEntry> {
        let mut out: Vec<AgentHistoryEntry> = self
            .records
            .lock()
            .iter()
            .filter(|r| r.worktree_path == worktree_path)
            .map(|r| AgentHistoryEntry {
                claude_session_id: r.claude_session_id.clone(),
                title: r.ai_title.clone().or_else(|| r.title.clone()),
                last_message: r.last_message.clone(),
                started_at: r.started_at,
                last_active_at: r.last_active_at,
                live_agent_id: None,
            })
            .collect();
        out.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
        out
    }

    /// The latest turn of one conversation, to seed the board card of an
    /// agent resuming it.
    pub fn last_turn(&self, claude_session_id: &str) -> Option<LastTurn> {
        self.records
            .lock()
            .iter()
            .find(|r| r.claude_session_id == claude_session_id)
            .map(|r| LastTurn {
                ai_title: r.ai_title.clone(),
                prompt: r.last_prompt.clone(),
                message: r.last_message.clone(),
            })
    }

    /// Forget one conversation. Claude's own transcript is left alone.
    pub fn forget(&self, claude_session_id: &str) {
        let mut records = self.records.lock();
        let n = records.len();
        records.retain(|r| r.claude_session_id != claude_session_id);
        if records.len() != n {
            self.save(&records);
        }
    }

    /// Forget every conversation in a worktree that's being removed:
    /// `--resume` can't find them once the directory is gone.
    pub fn forget_worktree(&self, worktree_path: &Path) {
        let mut records = self.records.lock();
        let n = records.len();
        records.retain(|r| r.worktree_path != worktree_path);
        if records.len() != n {
            self.save(&records);
        }
    }

    /// Write-then-rename so a crash mid-write can't truncate the file.
    /// Best-effort: a failed save only costs history.
    fn save(&self, records: &[Record]) {
        let Some(path) = self.path.lock().clone() else {
            return;
        };
        let file = HistoryFile {
            items: records.to_vec(),
        };
        let Ok(bytes) = serde_json::to_vec_pretty(&file) else {
            return;
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("json.tmp");
        let res = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &path));
        if let Err(e) = res {
            tracing::warn!(?e, path = %path.display(), "failed to save agent history");
        }
    }
}

fn upsert(
    records: &mut Vec<Record>,
    worktree_path: &Path,
    resumed_from: Option<&str>,
    claude_session_id: &str,
    first_prompt: Option<&str>,
    turn: &LastTurn,
    now_ms: u64,
) {
    let idx = records
        .iter()
        .position(|r| r.claude_session_id == claude_session_id)
        .or_else(|| {
            let from = resumed_from.filter(|f| *f != claude_session_id)?;
            records.iter().position(|r| r.claude_session_id == from)
        });
    let rec = match idx {
        Some(i) => &mut records[i],
        None => {
            records.push(Record {
                claude_session_id: claude_session_id.to_string(),
                worktree_path: worktree_path.to_path_buf(),
                title: None,
                last_prompt: None,
                ai_title: None,
                last_message: None,
                started_at: now_ms,
                last_active_at: now_ms,
            });
            records.last_mut().expect("just pushed")
        }
    };
    rec.claude_session_id = claude_session_id.to_string();
    rec.worktree_path = worktree_path.to_path_buf();
    if rec.title.is_none() {
        rec.title = first_prompt.map(str::to_string);
    }
    if let Some(t) = &turn.ai_title {
        rec.ai_title = Some(t.clone());
    }
    if let Some(p) = &turn.prompt {
        rec.last_prompt = Some(p.clone());
    }
    if let Some(m) = &turn.message {
        rec.last_message = Some(m.clone());
    }
    rec.last_active_at = now_ms;

    let mut in_worktree: Vec<(u64, String)> = records
        .iter()
        .filter(|r| r.worktree_path == worktree_path)
        .map(|r| (r.last_active_at, r.claude_session_id.clone()))
        .collect();
    if in_worktree.len() > PER_WORKTREE_MAX {
        in_worktree.sort_by(|a, b| b.0.cmp(&a.0));
        let drop: Vec<String> = in_worktree
            .split_off(PER_WORKTREE_MAX)
            .into_iter()
            .map(|(_, id)| id)
            .collect();
        records.retain(|r| !drop.contains(&r.claude_session_id));
    }
}

/// Claude session ids are UUIDs. Anything else is refused before it can
/// reach an argv, so a stray value can't turn into a flag.
pub fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wt() -> PathBuf {
        PathBuf::from("/r__worktrees/a")
    }

    fn turn(prompt: Option<&str>, message: Option<&str>) -> LastTurn {
        LastTurn {
            ai_title: None,
            prompt: prompt.map(str::to_string),
            message: message.map(str::to_string),
        }
    }

    #[test]
    fn first_prompt_sticks_and_last_message_updates() {
        let mut r = Vec::new();
        upsert(
            &mut r,
            &wt(),
            None,
            "s1",
            Some("fix the bug"),
            &turn(Some("fix the bug"), None),
            1,
        );
        upsert(
            &mut r,
            &wt(),
            None,
            "s1",
            Some("now add tests"),
            &turn(Some("now add tests"), Some("done")),
            2,
        );
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].title.as_deref(), Some("fix the bug"));
        assert_eq!(r[0].last_prompt.as_deref(), Some("now add tests"));
        assert_eq!(r[0].last_message.as_deref(), Some("done"));
        assert_eq!((r[0].started_at, r[0].last_active_at), (1, 2));
    }

    #[test]
    fn resume_with_new_id_rekeys_the_record() {
        let mut r = Vec::new();
        upsert(
            &mut r,
            &wt(),
            None,
            "s1",
            Some("fix the bug"),
            &turn(Some("fix the bug"), Some("ok")),
            1,
        );
        upsert(
            &mut r,
            &wt(),
            Some("s1"),
            "s2",
            Some("keep going"),
            &turn(Some("keep going"), None),
            5,
        );
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].claude_session_id, "s2");
        assert_eq!(r[0].title.as_deref(), Some("fix the bug"));
        assert_eq!(r[0].last_message.as_deref(), Some("ok"));
    }

    #[test]
    fn keeps_newest_per_worktree() {
        let mut r = Vec::new();
        let other = PathBuf::from("/r__worktrees/b");
        upsert(&mut r, &other, None, "other", None, &LastTurn::default(), 0);
        for i in 0..(PER_WORKTREE_MAX as u64 + 3) {
            upsert(
                &mut r,
                &wt(),
                None,
                &format!("s{i}"),
                None,
                &LastTurn::default(),
                i + 1,
            );
        }
        let ids: Vec<_> = r.iter().filter(|x| x.worktree_path == wt()).collect();
        assert_eq!(ids.len(), PER_WORKTREE_MAX);
        assert!(!r.iter().any(|x| x.claude_session_id == "s0"));
        assert!(r.iter().any(|x| x.claude_session_id == "other"));
    }

    #[test]
    fn loads_records_written_before_last_prompt_and_title() {
        let json = r#"{"items":[{"claudeSessionId":"s1","worktreePath":"/r__worktrees/a","title":"t","lastMessage":null,"startedAt":1,"lastActiveAt":1}]}"#;
        let file: HistoryFile = serde_json::from_str(json).unwrap();
        assert_eq!(
            (&file.items[0].last_prompt, &file.items[0].ai_title),
            (&None, &None)
        );
    }

    #[test]
    fn session_id_validation() {
        assert!(is_valid_session_id("7f3c2a1e-0b9d-4c8e-9f21-3a5b6c7d8e9f"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("--dangerously-skip-permissions"));
        assert!(!is_valid_session_id("a b"));
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(HISTORY_FILE);
        let h = AgentHistory::default();
        h.load(path.clone());
        let t = LastTurn {
            ai_title: Some("Greeting".into()),
            ..turn(Some("hello"), Some("hi"))
        };
        h.observe(&wt(), None, "s1", Some("hello"), &t, 10);
        let h2 = AgentHistory::default();
        h2.load(path);
        assert_eq!(h2.last_turn("s1"), Some(t));
        let list = h2.list_for(&wt());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title.as_deref(), Some("Greeting"));
        h2.forget_worktree(&wt());
        assert!(h2.list_for(&wt()).is_empty());
    }

    #[test]
    fn list_title_falls_back_to_first_prompt() {
        let h = AgentHistory::default();
        h.observe(
            &wt(),
            None,
            "s1",
            Some("fix the bug"),
            &LastTurn::default(),
            1,
        );
        assert_eq!(h.list_for(&wt())[0].title.as_deref(), Some("fix the bug"));
        let named = LastTurn {
            ai_title: Some("Login redirect loop".into()),
            ..LastTurn::default()
        };
        h.observe(&wt(), None, "s1", None, &named, 2);
        assert_eq!(
            h.list_for(&wt())[0].title.as_deref(),
            Some("Login redirect loop")
        );
    }
}
