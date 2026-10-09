//! Shell integration for terminal tabs: a startup hook that makes zsh mark
//! where each command starts and ends, and the scanner that reads those
//! marks back out of the PTY stream.
//!
//! The marks are the de-facto standard escape sequences (iTerm2, VS Code,
//! WezTerm…): `OSC 633;E;<command line>` then `OSC 133;C` before a command
//! runs, and `OSC 133;D;<exit code>` when it finishes. xterm.js ignores OSCs
//! it has no handler for, so they pass through to the renderer untouched.
//!
//! Injection works like VS Code's: `ZDOTDIR` points at a directory of
//! wrapper startup files that source the user's own (restoring `ZDOTDIR`
//! before `.zshrc`, so nested shells and the user's config see the real
//! value), then install `preexec` / `precmd` hooks. Other shells start
//! unmodified and simply report no commands.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use portable_pty::CommandBuilder;

const ZSHENV: &str = r#"# treehouse shell integration — sources your own startup files.
__th_ours=$ZDOTDIR
ZDOTDIR=${TREEHOUSE_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && . $ZDOTDIR/.zshenv
# Your .zshenv may have pointed ZDOTDIR elsewhere: .zshrc should come from there.
[[ $ZDOTDIR != $HOME ]] && TREEHOUSE_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__th_ours
unset __th_ours
"#;

const ZPROFILE: &str = r#"# treehouse shell integration — sources your own startup files.
__th_ours=$ZDOTDIR
ZDOTDIR=${TREEHOUSE_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zprofile ]] && . $ZDOTDIR/.zprofile
ZDOTDIR=$__th_ours
unset __th_ours
"#;

const ZSHRC: &str = r#"# treehouse shell integration — sources your own startup files, then marks
# command start / end for the worktree sidebar.
if [[ -n $TREEHOUSE_USER_ZDOTDIR ]]; then
  ZDOTDIR=$TREEHOUSE_USER_ZDOTDIR
else
  unset ZDOTDIR
fi
unset TREEHOUSE_USER_ZDOTDIR
[[ -f ${ZDOTDIR:-$HOME}/.zshrc ]] && . ${ZDOTDIR:-$HOME}/.zshrc

__th_preexec() {
  local s=${1//\\/\\\\}
  s=${s//$'\n'/\\x0a}
  s=${s//$'\t'/ }
  s=${s//[[:cntrl:]]/}
  __th_running=1
  printf '\e]633;E;%s\a\e]133;C\a' "$s"
}
__th_precmd() {
  local ec=$?
  if [[ -n $__th_running ]]; then
    printf '\e]133;D;%s\a' "$ec"
    unset __th_running
  fi
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec __th_preexec
# First, so no other hook clobbers `$?` before it's read.
precmd_functions=(__th_precmd ${precmd_functions:#__th_precmd})
"#;

/// Write the wrapper startup files once per app run. `None` if the temp
/// dir isn't writable — the terminal then starts without integration.
fn zsh_dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join("treehouse-shell-integration/zsh");
        let write = || -> std::io::Result<()> {
            std::fs::create_dir_all(&dir)?;
            std::fs::write(dir.join(".zshenv"), ZSHENV)?;
            std::fs::write(dir.join(".zprofile"), ZPROFILE)?;
            std::fs::write(dir.join(".zshrc"), ZSHRC)?;
            Ok(())
        };
        match write() {
            Ok(()) => Some(dir),
            Err(e) => {
                tracing::warn!(?e, "shell integration unavailable");
                None
            }
        }
    })
    .as_deref()
}

/// Point a shell's startup at the integration wrappers. Only zsh is
/// supported; any other shell is left as-is.
pub fn inject(cmd: &mut CommandBuilder, shell_path: &str) {
    let is_zsh = Path::new(shell_path)
        .file_name()
        .is_some_and(|n| n == "zsh");
    if !is_zsh {
        return;
    }
    let Some(dir) = zsh_dir() else { return };
    match std::env::var_os("ZDOTDIR") {
        Some(user) => cmd.env("TREEHOUSE_USER_ZDOTDIR", user),
        None => cmd.env_remove("TREEHOUSE_USER_ZDOTDIR"),
    }
    cmd.env("ZDOTDIR", dir);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mark {
    /// `OSC 633;E` — the command line about to run.
    CommandLine(String),
    /// `OSC 133;C` — the command started.
    Started,
    /// `OSC 133;D[;code]` — it finished.
    Finished(Option<i32>),
}

/// Longest OSC we'll buffer across reads. A command line longer than this
/// loses its mark; output keeps flowing either way.
const MAX_OSC: usize = 16 * 1024;

/// Pulls [`Mark`]s out of raw PTY output. Reads arrive in arbitrary chunks,
/// so an OSC cut off at the end of one is carried into the next.
#[derive(Default)]
pub struct MarkScanner {
    carry: Vec<u8>,
}

impl MarkScanner {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Mark> {
        let mut marks = Vec::new();
        let joined;
        let buf: &[u8] = if self.carry.is_empty() {
            chunk
        } else {
            self.carry.extend_from_slice(chunk);
            joined = std::mem::take(&mut self.carry);
            &joined
        };

        let mut i = 0;
        while let Some(off) = buf[i..].iter().position(|&b| b == 0x1b) {
            let start = i + off;
            match buf.get(start + 1) {
                None => {
                    self.carry = buf[start..].to_vec();
                    break;
                }
                Some(b']') => {}
                Some(_) => {
                    i = start + 1;
                    continue;
                }
            }
            let body = start + 2;
            // Terminated by BEL or ST (ESC \).
            let end = buf[body..]
                .iter()
                .enumerate()
                .find(|&(j, &b)| b == 0x07 || (b == 0x1b && buf.get(body + j + 1) == Some(&b'\\')))
                .map(|(j, &b)| (body + j, if b == 0x07 { 1 } else { 2 }));
            match end {
                Some((stop, term_len)) => {
                    if let Some(m) = parse(&buf[body..stop]) {
                        marks.push(m);
                    }
                    i = stop + term_len;
                }
                None => {
                    if buf.len() - start <= MAX_OSC {
                        self.carry = buf[start..].to_vec();
                    }
                    break;
                }
            }
        }
        marks
    }
}

fn parse(osc: &[u8]) -> Option<Mark> {
    if let Some(rest) = osc.strip_prefix(b"633;E;") {
        return Some(Mark::CommandLine(unescape(rest)));
    }
    let rest = osc.strip_prefix(b"133;")?;
    match rest.first()? {
        b'C' => Some(Mark::Started),
        b'D' => {
            let code = rest
                .get(2..)
                .and_then(|s| std::str::from_utf8(s).ok())
                .and_then(|s| s.split(';').next()?.parse().ok());
            Some(Mark::Finished(code))
        }
        _ => None,
    }
}

/// Undo the hook's escaping: `\\` → `\`, `\xHH` → that byte.
fn unescape(s: &[u8]) -> String {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == b'\\' {
            if s.get(i + 1) == Some(&b'\\') {
                out.push(b'\\');
                i += 2;
                continue;
            }
            if s.get(i + 1) == Some(&b'x') {
                let hex = s.get(i + 2..i + 4).and_then(|h| std::str::from_utf8(h).ok());
                if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    out.push(b);
                    i += 4;
                    continue;
                }
            }
        }
        out.push(s[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_command_cycle() {
        let mut s = MarkScanner::default();
        let marks = s.feed(
            b"prompt$ \x1b]633;E;docker build -t ci .\x07\x1b]133;C\x07output\r\n\x1b]133;D;1\x07",
        );
        assert_eq!(
            marks,
            vec![
                Mark::CommandLine("docker build -t ci .".into()),
                Mark::Started,
                Mark::Finished(Some(1)),
            ]
        );
    }

    #[test]
    fn carries_a_mark_split_across_reads() {
        let mut s = MarkScanner::default();
        assert!(s.feed(b"out\x1b]633;E;cargo te").is_empty());
        assert!(s.feed(b"st\x1b").is_empty());
        assert_eq!(
            s.feed(b"\\more"),
            vec![Mark::CommandLine("cargo test".into())]
        );
        assert!(s.feed(b"\x1b").is_empty());
        assert_eq!(s.feed(b"]133;C\x07"), vec![Mark::Started]);
    }

    #[test]
    fn ignores_other_escapes() {
        let mut s = MarkScanner::default();
        assert!(s
            .feed(b"\x1b[31mred\x1b[0m\x1b]0;title\x07\x1b]133;A\x07")
            .is_empty());
        assert_eq!(s.feed(b"\x1b]133;D\x07"), vec![Mark::Finished(None)]);
    }

    #[test]
    fn unescapes_the_command_line() {
        assert_eq!(unescape(br"echo a\\b\x0aecho c"), "echo a\\b\necho c");
    }
}
