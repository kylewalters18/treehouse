//! CI job logs: split a raw log into the sections each forge marks, and turn
//! a log into plain text for agents.
//!
//! GitLab marks sections inline (`section_start:<unix ts>:<name>` …
//! `section_end:<unix ts>:<name>`, possibly nested and chained on one line).
//! GitHub's log has no section markers, but every line carries a timestamp
//! and the job's steps carry start times, so lines are assigned to the step
//! that was running when they were written.

use super::types::{ForgeJobLog, ForgeLogSection};

/// Keep at most this much of a log for the viewer. GitLab traces and Actions
/// logs can run to many MB; failures live at the end.
pub const VIEW_LOG_BYTES: usize = 1_000_000;

/// The last `max` bytes of `s`, cut at a line start, and whether anything was
/// dropped.
pub fn tail(s: &str, max: usize) -> (&str, bool) {
    if s.len() <= max {
        return (s, false);
    }
    let start = s.len() - max;
    let start = (start..s.len())
        .find(|&i| s.is_char_boundary(i))
        .unwrap_or(s.len());
    let cut = s[start..]
        .find('\n')
        .map(|i| start + i + 1)
        .unwrap_or(start);
    (&s[cut..], true)
}

/// Drop terminal noise from a CI log: ANSI escapes, GitLab's section
/// markers, and carriage returns. Mirrors the renderer's `stripAnsi`
/// (src/lib/ansi.ts).
pub fn plain_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while !rest.is_empty() {
        if let Some(m) = Marker::parse(rest) {
            rest = &rest[m.len..];
            continue;
        }
        let mut chars = rest.chars();
        let c = chars.next().expect("non-empty");
        rest = chars.as_str();
        match c {
            '\x1b' => rest = skip_escape(rest),
            '\r' => {}
            _ => out.push(c),
        }
    }
    out
}

/// After an ESC: skip a CSI sequence (`[` params, final letter) if one follows.
fn skip_escape(rest: &str) -> &str {
    let Some(params) = rest.strip_prefix('[') else {
        return rest;
    };
    match params.find(|c: char| c.is_ascii_alphabetic()) {
        Some(i) => &params[i + 1..],
        None => "",
    }
}

/// One GitLab `section_start:` / `section_end:` marker at the start of a
/// string, with the `\r` + erase-line that follows it.
struct Marker<'a> {
    start: bool,
    ts: u64,
    name: &'a str,
    /// Bytes the marker spans.
    len: usize,
}

impl<'a> Marker<'a> {
    fn parse(s: &'a str) -> Option<Self> {
        let (start, after) = if let Some(a) = s.strip_prefix("section_start:") {
            (true, a)
        } else {
            (false, s.strip_prefix("section_end:")?)
        };
        let ts_len = after.find(|c: char| !c.is_ascii_digit())?;
        let ts = after[..ts_len].parse().ok()?;
        let after = after[ts_len..].strip_prefix(':')?;
        let name_len = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')))
            .unwrap_or(after.len());
        if name_len == 0 {
            return None;
        }
        let name = &after[..name_len];
        let mut tail = &after[name_len..];
        // Options like `[collapsed=true]`.
        if tail.starts_with('[') {
            if let Some(i) = tail.find(']') {
                tail = &tail[i + 1..];
            }
        }
        tail = tail.strip_prefix('\r').unwrap_or(tail);
        tail = tail.strip_prefix("\x1b[0K").unwrap_or(tail);
        Some(Marker {
            start,
            ts,
            name,
            len: s.len() - tail.len(),
        })
    }
}

/// Split a GitLab trace into its top-level sections. A section's title is
/// the header line GitLab prints right after its start marker (falling back
/// to the marker's name); nested sections stay inside their parent's text.
pub fn gitlab_sections(raw: &str) -> Vec<ForgeLogSection> {
    let mut sections = Vec::new();
    let mut buf = String::new();
    // (title, start ts) of the open top-level section.
    let mut open: Option<(String, u64)> = None;
    let mut stack: Vec<&str> = Vec::new();
    let mut rest = raw;

    while !rest.is_empty() {
        let next = rest.find("section_").unwrap_or(rest.len());
        buf.push_str(&rest[..next]);
        rest = &rest[next..];
        if rest.is_empty() {
            break;
        }
        let Some(m) = Marker::parse(rest) else {
            buf.push_str("section_");
            rest = &rest["section_".len()..];
            continue;
        };
        rest = &rest[m.len..];
        if m.start {
            if stack.is_empty() {
                push_section(&mut sections, std::mem::take(&mut buf), None, None);
                // The header is the rest of the marker's line.
                let line_end = rest.find('\n').map(|i| i + 1).unwrap_or(rest.len());
                let header = plain_text(&rest[..line_end]).trim().to_string();
                rest = &rest[line_end..];
                let title = if header.is_empty() {
                    m.name.to_string()
                } else {
                    header
                };
                open = Some((title, m.ts));
            }
            stack.push(m.name);
        } else {
            match stack.iter().rposition(|n| *n == m.name) {
                Some(i) => stack.truncate(i),
                None => continue, // an end we never saw start (tail cut)
            }
            if stack.is_empty() {
                if let Some((title, start)) = open.take() {
                    let secs = m.ts.saturating_sub(start);
                    push_section(
                        &mut sections,
                        std::mem::take(&mut buf),
                        Some(title),
                        Some(secs),
                    );
                }
            }
        }
    }
    match open {
        Some((title, _)) => push_section(&mut sections, buf, Some(title), None),
        None => push_section(&mut sections, buf, None, None),
    }
    sections
}

fn push_section(
    sections: &mut Vec<ForgeLogSection>,
    text: String,
    name: Option<String>,
    duration_secs: Option<u64>,
) {
    // Unnamed filler between sections is usually just erase-line codes.
    if name.is_none() && plain_text(&text).trim().is_empty() {
        return;
    }
    sections.push(ForgeLogSection {
        name: name.unwrap_or_default(),
        text: text.trim_end_matches(['\n', '\r']).to_string(),
        duration_secs,
        status: None,
    });
}

/// A GitHub Actions step, as needed to split its job's log.
pub struct Step {
    pub name: String,
    pub status: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

/// Split an Actions job log by step. Each line goes to the latest step that
/// had started by the line's timestamp (whole seconds — when the next step
/// started in the same second, only a `##[group]` line, which opens a step's
/// output, moves on to it). Steps with no output (skipped) are kept so the
/// list matches GitHub's.
pub fn github_sections(raw: &str, steps: &[Step]) -> Vec<ForgeLogSection> {
    if steps.is_empty() {
        let text = raw.lines().map(github_line).collect::<Vec<_>>().join("\n");
        let mut out = Vec::new();
        push_section(&mut out, text, None, None);
        return out;
    }
    let starts: Vec<Option<i64>> = steps
        .iter()
        .map(|s| s.started_at.as_deref().and_then(parse_iso_secs))
        .collect();
    let mut texts: Vec<Vec<String>> = vec![Vec::new(); steps.len()];
    let mut cur = 0usize;
    for line in raw.lines() {
        let (ts, body) = split_timestamp(line);
        if let Some(ts) = ts {
            // Advance past every later step that had started by an earlier
            // second; a `##[group]` line also opens (only) the next step
            // that started this second.
            let group = body.starts_with("##[group]");
            for (j, start) in starts.iter().enumerate().skip(cur + 1) {
                match *start {
                    Some(s) if s < ts => cur = j,
                    Some(s) if s == ts && group => {
                        cur = j;
                        break;
                    }
                    Some(_) => break,
                    None => {}
                }
            }
        }
        if body == "##[endgroup]" {
            continue;
        }
        texts[cur].push(github_line(body));
    }
    steps
        .iter()
        .zip(texts)
        .map(|(s, lines)| ForgeLogSection {
            name: s.name.clone(),
            text: lines.join("\n"),
            duration_secs: match (
                s.started_at.as_deref().and_then(parse_iso_secs),
                s.completed_at.as_deref().and_then(parse_iso_secs),
            ) {
                (Some(a), Some(b)) if b >= a => Some((b - a) as u64),
                _ => None,
            },
            status: Some(s.status.clone()),
        })
        .collect()
}

/// `2024-05-01T12:00:00.1234567Z rest` → (epoch seconds, `rest`).
fn split_timestamp(line: &str) -> (Option<i64>, &str) {
    let b = line.as_bytes();
    if b.len() > 20 && b[4] == b'-' && b[10] == b'T' {
        if let Some(i) = line.find("Z ") {
            if i < 40 {
                return (parse_iso_secs(&line[..=i]), &line[i + 2..]);
            }
        }
    }
    (None, line)
}

/// Render Actions workflow commands the way GitHub's log viewer does, as
/// ANSI so the renderer's one log path styles both forges.
fn github_line(line: &str) -> String {
    let (_, line) = split_timestamp(line);
    if let Some(rest) = line.strip_prefix("##[group]") {
        format!("\x1b[1m{rest}\x1b[0m")
    } else if let Some(rest) = line.strip_prefix("##[error]") {
        format!("\x1b[31mError: {rest}\x1b[0m")
    } else if let Some(rest) = line.strip_prefix("##[warning]") {
        format!("\x1b[33mWarning: {rest}\x1b[0m")
    } else if let Some(rest) = line.strip_prefix("##[notice]") {
        format!("\x1b[36mNotice: {rest}\x1b[0m")
    } else if let Some(rest) = line.strip_prefix("[command]") {
        format!("\x1b[36m{rest}\x1b[0m")
    } else {
        line.to_string()
    }
}

/// Seconds since the epoch for an RFC 3339 UTC-ish timestamp
/// (`2024-05-01T12:00:00Z`, fractional seconds and `±HH:MM` offsets allowed).
pub fn parse_iso_secs(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (h, mi, sec) = (n(11..13)?, n(14..16)?, n(17..19)?);
    let mut rest = &s[19..];
    if let Some(r) = rest.strip_prefix('.') {
        rest = r.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    let offset = match rest.as_bytes().first() {
        None | Some(b'Z') => 0,
        Some(&sign @ (b'+' | b'-')) => {
            let oh: i64 = rest.get(1..3)?.parse().ok()?;
            let om: i64 = rest.get(4..6)?.parse().ok()?;
            let o = oh * 3600 + om * 60;
            if sign == b'+' {
                o
            } else {
                -o
            }
        }
        _ => return None,
    };
    // Days from civil (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + sec - offset)
}

/// Bound a raw log for the viewer and split it.
pub fn view_log(raw: &str, split: impl FnOnce(&str) -> Vec<ForgeLogSection>) -> ForgeJobLog {
    let (kept, truncated) = tail(raw, VIEW_LOG_BYTES);
    ForgeJobLog {
        sections: split(kept),
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_strips_ansi_sections_and_cr() {
        let raw =
            "section_start:1700000000:build_script\r\x1b[0K\x1b[32;1m$ cargo test\x1b[0;m\r\n\
                   progress 50%\rprogress 100%\n\
                   section_end:1700000001:build_script\r\x1b[0Kdone section_x\n";
        assert_eq!(
            plain_text(raw),
            "$ cargo test\nprogress 50%progress 100%\ndone section_x\n"
        );
    }

    #[test]
    fn gitlab_splits_top_level_sections_with_headers() {
        let raw = "Running with gitlab-runner 17.0\n\
            section_start:100:prepare_executor\r\x1b[0K\x1b[36;1mPreparing the executor\x1b[0;m\n\
            Using docker\n\
            section_end:103:prepare_executor\r\x1b[0Ksection_start:103:step_script[collapsed=false]\r\x1b[0KExecuting step_script\n\
            $ cargo test\n\
            section_start:104:inner\r\x1b[0Knested header\n\
            inner line\n\
            section_end:110:inner\r\x1b[0K\
            test result: FAILED\n\
            section_end:205:step_script\r\x1b[0K\n\
            \x1b[31;1mERROR: Job failed: exit code 101\x1b[0;m\n";
        let s = gitlab_sections(raw);
        let names: Vec<&str> = s.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(
            names,
            ["", "Preparing the executor", "Executing step_script", ""]
        );
        assert_eq!(s[1].text, "Using docker");
        assert_eq!(s[1].duration_secs, Some(3));
        assert_eq!(s[2].duration_secs, Some(102));
        assert!(
            s[2].text
                .contains("nested header\ninner line\ntest result: FAILED"),
            "{:?}",
            s[2].text
        );
        assert!(s[3].text.contains("ERROR: Job failed"));
    }

    #[test]
    fn gitlab_unterminated_section_stays_open() {
        let s = gitlab_sections("section_start:1:step_script\r\x1b[0K\nrunning…\n");
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].name, "step_script");
        assert_eq!(s[0].duration_secs, None);
        assert_eq!(s[0].text, "running…");
    }

    fn step(name: &str, start: &str, end: &str) -> Step {
        Step {
            name: name.into(),
            status: "success".into(),
            started_at: Some(start.into()),
            completed_at: Some(end.into()),
        }
    }

    #[test]
    fn github_assigns_lines_to_steps_by_time() {
        let steps = vec![
            step("Set up job", "2026-01-01T00:00:00Z", "2026-01-01T00:00:02Z"),
            step("Checkout", "2026-01-01T00:00:02Z", "2026-01-01T00:00:02Z"),
            step("Test", "2026-01-01T00:00:02Z", "2026-01-01T00:01:00Z"),
            Step {
                name: "Deploy".into(),
                status: "skipped".into(),
                started_at: None,
                completed_at: None,
            },
        ];
        let raw = "2026-01-01T00:00:00.1Z Current runner version: '2.3'\n\
            2026-01-01T00:00:02.1Z Prepare workflow directory\n\
            2026-01-01T00:00:02.2Z ##[group]Run actions/checkout@v4\n\
            2026-01-01T00:00:02.3Z with: x\n\
            2026-01-01T00:00:02.3Z ##[endgroup]\n\
            2026-01-01T00:00:02.5Z ##[group]Run cargo test\n\
            2026-01-01T00:00:59.0Z ##[error]Process completed with exit code 101.\n";
        let s = github_sections(raw, &steps);
        assert_eq!(s.len(), 4);
        assert_eq!(
            s[0].text,
            "Current runner version: '2.3'\nPrepare workflow directory"
        );
        assert_eq!(s[1].text, "\x1b[1mRun actions/checkout@v4\x1b[0m\nwith: x");
        assert_eq!(
            s[2].text,
            "\x1b[1mRun cargo test\x1b[0m\n\x1b[31mError: Process completed with exit code 101.\x1b[0m"
        );
        assert_eq!(s[2].duration_secs, Some(58));
        assert_eq!(s[3].text, "");
        assert_eq!(s[3].status.as_deref(), Some("skipped"));
    }

    #[test]
    fn iso_parsing() {
        assert_eq!(parse_iso_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_secs("2024-03-01T00:00:00Z"), Some(1_709_251_200));
        assert_eq!(
            parse_iso_secs("2024-03-01T01:00:00.123+01:00"),
            Some(1_709_251_200)
        );
        assert_eq!(parse_iso_secs("nope"), None);
    }

    #[test]
    fn tail_cuts_at_line_start() {
        assert_eq!(tail("abc\ndef\nghi", 6), ("ghi", true));
        assert_eq!(tail("short", 10), ("short", false));
    }
}
