//! TS-exported types shared with the renderer. These are the *normalized*
//! shapes — each provider maps its raw CLI/REST JSON into these in its own
//! `into_normalized()` so the frontend never sees GitLab-vs-GitHub field drift.
//!
//! Note the `#[ts(type = "number")]` overrides on every `u64`/`u32`: ts-rs
//! defaults integers to `bigint`, which can't round-trip over Tauri's
//! `JSON.stringify`-based IPC. All of these fit comfortably in
//! `Number.MAX_SAFE_INTEGER`. See `storage::Comment` for the same pattern.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Which forge a workspace's remote points at. `Unknown` = a remote we
/// couldn't classify (e.g. a self-managed host without "gitlab"/"github"
/// in the name) — the UI stays quiet rather than guessing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ForgeKind {
    Github,
    Gitlab,
    Unknown,
}

/// Availability + auth of the forge CLI for a workspace. Always well-formed
/// (never errors) so the UI can render an "install / `glab auth login`" prompt.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeStatus {
    pub kind: ForgeKind,
    pub host: Option<String>,
    /// `glab`/`gh` is on PATH.
    pub installed: bool,
    /// `glab/gh auth status` exited cleanly.
    pub authenticated: bool,
    /// The authenticated user's username, when known — used to drive the
    /// "assigned to you" self-assign toggle.
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeIssue {
    /// GitHub number / GitLab iid, normalized to one field.
    #[ts(type = "number")]
    pub number: u64,
    pub title: String,
    pub body: String,
    /// Normalized lowercase: "open" | "closed".
    pub state: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub url: String,
    /// ISO-8601 passthrough.
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeMr {
    /// GitHub PR number / GitLab MR iid.
    #[ts(type = "number")]
    pub number: u64,
    pub title: String,
    pub source_branch: String,
    pub target_branch: String,
    /// Normalized lowercase: "open" | "merged" | "closed".
    pub state: String,
    pub url: String,
    pub draft: bool,
    /// GitLab's `detailed_merge_status` — e.g. "mergeable",
    /// "discussions_not_resolved", "ci_must_pass", "not_approved", "conflict".
    /// Drives the "why can't I merge" hint. `None` when unknown.
    pub merge_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgePipeline {
    #[ts(type = "number")]
    pub id: u64,
    /// Branch/ref the pipeline ran against.
    pub ref_name: String,
    pub sha: String,
    /// GitLab: created|pending|running|success|failed|canceled|skipped.
    pub status: String,
    pub web_url: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeJob {
    #[ts(type = "number")]
    pub id: u64,
    pub name: String,
    pub stage: String,
    pub status: String,
    /// True for a superseded run (a later retry replaced it). The current run
    /// of a job is `retried: false`. Retried runs are kept only so stage order
    /// can be computed from the earliest job id per stage.
    pub retried: bool,
}

/// One review/discussion thread on an MR/PR. `id` is the discussion id used
/// to target a threaded reply.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeThread {
    pub id: String,
    pub notes: Vec<ForgeNote>,
    /// This discussion can be resolved (it has resolvable notes — i.e. it's a
    /// review thread, not a plain system/general note).
    pub resolvable: bool,
    /// All resolvable notes in the discussion are resolved.
    pub resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeNote {
    #[ts(type = "number")]
    pub id: u64,
    pub author: String,
    pub body: String,
    /// Present iff this is an inline (diff-anchored) note.
    pub position: Option<ForgePosition>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgePosition {
    pub new_path: Option<String>,
    #[ts(type = "number | null")]
    pub new_line: Option<u32>,
    pub old_path: Option<String>,
    #[ts(type = "number | null")]
    pub old_line: Option<u32>,
}

/// The current user's approval state for an MR/PR, so the UI can toggle
/// between Approve and Unapprove.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForgeApproval {
    /// The current user has approved this MR/PR.
    pub approved: bool,
    /// The current user is eligible to approve.
    pub can_approve: bool,
}

/// Input for a line-anchored review comment — mirrors the renderer's stored
/// `Comment` (filePath + line + text). The provider fetches the diff SHAs itself.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewCommentInput {
    pub file_path: String,
    pub line: u32,
    pub body: String,
}

/// Normalize a forge state string to lowercase `open`/`closed`/`merged`.
/// GitLab emits `opened`; GitHub emits uppercase `OPEN`.
pub(crate) fn normalize_state(s: &str) -> String {
    match s.to_ascii_lowercase().as_str() {
        "opened" | "open" => "open".to_string(),
        other => other.to_string(),
    }
}
