//! On-demand detail for the sidebar's worktree hover card: uncommitted
//! files, terminals and the ports they listen on, language servers, CPU /
//! memory of everything running in the worktree, and disk usage.
//!
//! Unlike `status`, nothing here is cached or pushed: it's gathered when
//! the card opens (a `git status`, one `ps` and two `lsof` calls), except
//! disk usage, which walks the whole tree and so is its own command with a
//! short-lived cache.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::Serialize;
use tokio::process::Command;
use ts_rs::TS;

use crate::pty::TerminalCommand;
use crate::state::AppState;
use crate::util::errors::{AppError, AppResult};
use crate::util::ids::{TerminalId, WorktreeId};
use crate::worktree::git_ops;

/// Files listed in the card; the rest are summarized by `changed_total`.
const MAX_CHANGED_FILES: usize = 50;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorktreeDetails {
    pub path: String,
    /// The first [`MAX_CHANGED_FILES`] of `git status --porcelain`.
    pub changed_files: Vec<ChangedFile>,
    pub changed_total: u32,
    /// Every live terminal, oldest first.
    pub terminals: Vec<TerminalDetail>,
    /// Language ids of the worktree's running language servers.
    pub lsp_servers: Vec<String>,
    /// TCP ports listened on by any process in the worktree.
    pub ports: Vec<u16>,
    /// `None` when the process table couldn't be read.
    pub processes: Option<ProcessUsage>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChangedFile {
    /// Porcelain status letters, e.g. `M`, `A`, `??`.
    pub status: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalDetail {
    pub terminal_id: TerminalId,
    pub command: Option<TerminalCommand>,
    /// TCP ports listened on by processes started from this terminal.
    pub ports: Vec<u16>,
}

/// Summed over processes whose working directory is in the worktree, plus
/// their descendants and the worktree's terminal shells.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProcessUsage {
    pub count: u32,
    /// `ps`'s %CPU — 100 is one full core.
    pub cpu_percent: f32,
    #[ts(type = "number")]
    pub rss_bytes: u64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiskUsage {
    #[ts(type = "number")]
    pub total_bytes: u64,
    /// Top-level entries, largest first (at most 5).
    pub largest: Vec<DiskEntry>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiskEntry {
    pub name: String,
    #[ts(type = "number")]
    pub bytes: u64,
}

pub async fn details(state: &AppState, worktree_id: WorktreeId) -> AppResult<WorktreeDetails> {
    let path = worktree_path(state, worktree_id)?;
    let commands: HashMap<TerminalId, TerminalCommand> =
        crate::pty::manager::commands_for_worktree(&state.terminals, worktree_id)
            .into_iter()
            .map(|c| (c.terminal_id, c))
            .collect();
    let mut shells = crate::pty::manager::shell_pids_for_worktree(&state.terminals, worktree_id);
    shells.sort_by_key(|(id, _)| *id);
    let lsp_servers = state
        .lsp
        .list_for_worktree(worktree_id)
        .into_iter()
        .map(|s| s.language_id)
        .collect();

    let (changed, procs, cwds, listening) = tokio::join!(
        git_ops::git(&path, ["status", "--porcelain"]),
        process_table(),
        process_cwds(),
        listening_ports(),
    );

    let changed: Vec<ChangedFile> = changed
        .unwrap_or_default()
        .lines()
        .filter(|l| l.len() > 3)
        .map(|l| ChangedFile {
            status: l[..2].trim().to_string(),
            path: l[3..].to_string(),
        })
        .collect();

    let canonical = dunce::canonicalize(&path).unwrap_or_else(|_| path.clone());
    let roots: Vec<u32> = cwds
        .iter()
        .filter(|(_, cwd)| cwd.starts_with(&canonical))
        .map(|(pid, _)| *pid)
        .chain(shells.iter().map(|(_, pid)| *pid))
        .collect();

    let (processes, members, parent) = match procs {
        Some(table) => {
            let members = with_descendants(&table, &roots);
            let mut usage = ProcessUsage {
                count: 0,
                cpu_percent: 0.0,
                rss_bytes: 0,
            };
            for p in table.iter().filter(|p| members.contains(&p.pid)) {
                usage.count += 1;
                usage.cpu_percent += p.cpu;
                usage.rss_bytes += p.rss_kb * 1024;
            }
            let parent: HashMap<u32, u32> = table.iter().map(|p| (p.pid, p.ppid)).collect();
            (Some(usage), members, parent)
        }
        None => (None, roots.iter().copied().collect(), HashMap::new()),
    };

    let mut ports: Vec<u16> = listening
        .iter()
        .filter(|(pid, _)| members.contains(pid))
        .map(|(_, port)| *port)
        .collect();
    ports.sort_unstable();
    ports.dedup();

    let terminals = shells
        .iter()
        .map(|(id, shell_pid)| {
            let mut ports: Vec<u16> = listening
                .iter()
                .filter(|(pid, _)| descends_from(&parent, *pid, *shell_pid))
                .map(|(_, port)| *port)
                .collect();
            ports.sort_unstable();
            ports.dedup();
            TerminalDetail {
                terminal_id: *id,
                command: commands.get(id).cloned(),
                ports,
            }
        })
        .collect();

    Ok(WorktreeDetails {
        path: path.display().to_string(),
        changed_total: changed.len() as u32,
        changed_files: changed.into_iter().take(MAX_CHANGED_FILES).collect(),
        terminals,
        lsp_servers,
        ports,
        processes,
    })
}

/// How long a disk-usage walk is reused. Long enough that hovering back and
/// forth doesn't re-walk a multi-GB `target/`.
const DISK_TTL: Duration = Duration::from_secs(120);

pub async fn disk_usage(state: &AppState, worktree_id: WorktreeId) -> AppResult<DiskUsage> {
    static CACHE: OnceLock<DashMap<PathBuf, (Instant, DiskUsage)>> = OnceLock::new();
    let cache = CACHE.get_or_init(DashMap::new);
    let path = worktree_path(state, worktree_id)?;
    if let Some(hit) = cache.get(&path) {
        if hit.0.elapsed() < DISK_TTL {
            return Ok(hit.1.clone());
        }
    }

    let mut names: Vec<String> = std::fs::read_dir(&path)
        .map_err(|e| AppError::Io(format!("read {}: {e}", path.display())))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let mut entries: Vec<DiskEntry> = Vec::new();
    if !names.is_empty() {
        let out = Command::new("du")
            .arg("-sk")
            .arg("--")
            .args(&names)
            .current_dir(&path)
            .output()
            .await
            .map_err(|e| AppError::Io(format!("du: {e}")))?;
        // du exits non-zero on an unreadable file but still reports the rest.
        entries = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let (kb, name) = l.split_once('\t')?;
                Some(DiskEntry {
                    name: name.to_string(),
                    bytes: kb.trim().parse::<u64>().ok()? * 1024,
                })
            })
            .collect();
    }
    let total_bytes = entries.iter().map(|e| e.bytes).sum();
    entries.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    entries.truncate(5);
    let usage = DiskUsage {
        total_bytes,
        largest: entries,
    };
    cache.insert(path, (Instant::now(), usage.clone()));
    Ok(usage)
}

fn worktree_path(state: &AppState, worktree_id: WorktreeId) -> AppResult<PathBuf> {
    state
        .worktrees
        .get(&worktree_id)
        .map(|w| w.path.clone())
        .ok_or_else(|| AppError::Unknown(format!("unknown worktree: {worktree_id}")))
}

struct Proc {
    pid: u32,
    ppid: u32,
    cpu: f32,
    rss_kb: u64,
}

async fn process_table() -> Option<Vec<Proc>> {
    let out = Command::new("ps")
        .args(["-axo", "pid=,ppid=,pcpu=,rss="])
        .output()
        .await
        .ok()?;
    Some(parse_ps(&String::from_utf8_lossy(&out.stdout)))
}

fn parse_ps(text: &str) -> Vec<Proc> {
    text.lines()
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            Some(Proc {
                pid: f.next()?.parse().ok()?,
                ppid: f.next()?.parse().ok()?,
                cpu: f.next()?.parse().ok()?,
                rss_kb: f.next()?.parse().ok()?,
            })
        })
        .collect()
}

/// Working directory of every process we can see.
async fn process_cwds() -> Vec<(u32, PathBuf)> {
    let Ok(out) = Command::new("lsof")
        .args(["-n", "-d", "cwd", "-F", "pn"])
        .output()
        .await
    else {
        return Vec::new();
    };
    parse_lsof(&String::from_utf8_lossy(&out.stdout))
        .into_iter()
        .map(|(pid, n)| (pid, PathBuf::from(n)))
        .collect()
}

/// `(pid, port)` for every listening TCP socket we can see.
async fn listening_ports() -> Vec<(u32, u16)> {
    let Ok(out) = Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"])
        .output()
        .await
    else {
        return Vec::new();
    };
    parse_lsof(&String::from_utf8_lossy(&out.stdout))
        .into_iter()
        .filter_map(|(pid, n)| Some((pid, n.rsplit_once(':')?.1.parse().ok()?)))
        .collect()
}

/// `lsof -F pn` output → `(pid, name)` per file: `p<pid>` opens a process,
/// each following `n<name>` is one of its files.
fn parse_lsof(text: &str) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let mut pid = None;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().ok();
        } else if let (Some(n), Some(pid)) = (line.strip_prefix('n'), pid) {
            out.push((pid, n.to_string()));
        }
    }
    out
}

fn with_descendants(table: &[Proc], roots: &[u32]) -> HashSet<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in table {
        children.entry(p.ppid).or_default().push(p.pid);
    }
    let me = std::process::id();
    let mut seen = HashSet::new();
    let mut stack: Vec<u32> = roots.iter().copied().filter(|&p| p != me).collect();
    while let Some(pid) = stack.pop() {
        if seen.insert(pid) {
            stack.extend(children.get(&pid).into_iter().flatten().copied());
        }
    }
    seen
}

fn descends_from(parent: &HashMap<u32, u32>, mut pid: u32, ancestor: u32) -> bool {
    // Bounded: a malformed table can't loop us forever.
    for _ in 0..64 {
        if pid == ancestor {
            return true;
        }
        match parent.get(&pid) {
            Some(&pp) if pp != pid && pp != 0 => pid = pp,
            _ => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lsof_fields() {
        let text = "p10\nfcwd\nn/a/b\np11\nf9\nn*:5173\nf10\nn[::1]:5173\n";
        assert_eq!(
            parse_lsof(text),
            vec![
                (10, "/a/b".to_string()),
                (11, "*:5173".to_string()),
                (11, "[::1]:5173".to_string()),
            ]
        );
    }

    #[test]
    fn walks_descendants_and_ancestry() {
        let table = parse_ps("  1     0  0.0  100\n 10     1  5.0 2000\n 11    10 50.0 4000\n 12    11  1.5  500\n 20     1  0.0   10\n");
        let members = with_descendants(&table, &[10]);
        assert_eq!(members, HashSet::from([10, 11, 12]));
        let parent: HashMap<u32, u32> = table.iter().map(|p| (p.pid, p.ppid)).collect();
        assert!(descends_from(&parent, 12, 10));
        assert!(!descends_from(&parent, 20, 10));
    }
}
