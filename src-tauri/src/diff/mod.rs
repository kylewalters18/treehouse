pub mod compute;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use ts_rs::TS;

use crate::util::ids::WorktreeId;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiffSet {
    pub worktree_id: WorktreeId,
    pub base_ref: String,
    /// Unix epoch milliseconds.
    pub computed_at: u64,
    pub files: Vec<FileDiff>,
    pub stats: DiffStats,
    /// When true, file contents and hunks are elided (repo too large).
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiffStats {
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileDiff {
    #[ts(type = "string")]
    pub path: PathBuf,
    pub status: FileStatus,
    pub hunks: Vec<Hunk>,
    pub binary: bool,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export)]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed {
        #[ts(type = "string")]
        from: PathBuf,
    },
    Untracked,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Hunk {
    /// Stable within a DiffSet — FNV hash of the hunk header + body.
    pub id: String,
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export)]
pub enum DiffLine {
    Ctx { content: String },
    Add { content: String },
    Del { content: String },
}

/// Hard cap: if a diff exceeds these, we return a summary with no hunks.
pub const MAX_FILES: usize = 2000;
pub const MAX_LINES: u32 = 500_000;

/// Which view of the worktree's changes the user is asking for.
/// `Branch` is the default — everything since `merge-base(default,
/// branch)`, the GitHub PR-style "what would land if I merged this"
/// view. `Uncommitted` shows just `HEAD..workdir` — the agent's
/// most recent batch of edits, easier to review in isolation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DiffMode {
    #[default]
    Branch,
    Uncommitted,
}
