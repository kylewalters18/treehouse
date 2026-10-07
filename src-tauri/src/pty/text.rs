//! Raw PTY bytes → readable text, for handing a terminal's scrollback to an
//! agent. Not a terminal emulator: escape sequences are dropped, a bare `\r`
//! restarts the line (progress bars keep their last frame) and backspace
//! erases a character. Good for logs and command output; a full-screen TUI
//! (vim, htop) won't come out meaningfully.

/// Render `bytes` and keep the last `max_lines` non-trailing-blank lines.
pub fn render_tail(bytes: &[u8], max_lines: usize) -> String {
    let text = render(bytes);
    let lines: Vec<&str> = text.lines().collect();
    let end = lines
        .iter()
        .rposition(|l| !l.trim().is_empty())
        .map_or(0, |i| i + 1);
    let start = end.saturating_sub(max_lines);
    lines[start..end].join("\n")
}

pub fn render(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(s.len());
    let mut line = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                // CSI: parameters, then a final byte in @..~.
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC / DCS / SOS / PM / APC: up to BEL or ST (ESC \).
                Some(']' | 'P' | 'X' | '^' | '_') => {
                    while let Some(c) = chars.next() {
                        if c == '\x07' {
                            break;
                        }
                        if c == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                // Charset designations take one more byte.
                Some('(' | ')' | '*' | '+') => {
                    chars.next();
                }
                _ => {}
            },
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    line.clear();
                }
            }
            '\n' => {
                out.push_str(line.trim_end());
                out.push('\n');
                line.clear();
            }
            '\x08' => {
                line.pop();
            }
            '\t' => line.push('\t'),
            c if (c as u32) < 0x20 || c == '\x7f' => {}
            c => line.push(c),
        }
    }
    out.push_str(line.trim_end());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_escapes_and_titles() {
        let raw = b"\x1b]2;~/repo\x07\x1b[1m\x1b[32m\xe2\x9e\x9c\x1b[0m repo git:(\x1b[31mmain\x1b[0m) npm run dev\r\n\x1b(B\x1b[mVITE ready\r\n";
        assert_eq!(render(raw), "➜ repo git:(main) npm run dev\nVITE ready\n");
    }

    #[test]
    fn carriage_return_keeps_last_frame() {
        assert_eq!(
            render(b"progress 10%\rprogress 100%\r\ndone"),
            "progress 100%\ndone"
        );
    }

    #[test]
    fn backspace_erases() {
        assert_eq!(render(b"lss\x08 -la"), "ls -la");
    }

    #[test]
    fn zsh_prompt_sp_artifact_is_dropped() {
        // PROMPT_SP: `%` + padding + `\r` before the next prompt.
        assert_eq!(render(b"out\r\n%     \r$ "), "out\n$");
    }

    #[test]
    fn tail_skips_trailing_blank_lines() {
        assert_eq!(render_tail(b"a\nb\nc\n\n  \n", 2), "b\nc");
        assert_eq!(render_tail(b"", 5), "");
    }
}
