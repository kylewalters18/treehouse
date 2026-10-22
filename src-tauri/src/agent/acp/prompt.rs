//! Turning a prompt box submission (text + `@file` mentions + pasted
//! images) into ACP `session/prompt` content blocks, within what the agent
//! said it accepts at `initialize`.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use super::view::PromptCaps;

/// Image files attached from disk up to this size go as image blocks.
const IMAGE_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Image MIME type for a path, by extension.
fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// Files up to this size are embedded (the agent gets the contents up
/// front); bigger ones, or binary ones, go as links the agent can read.
const EMBED_MAX_BYTES: u64 = 256 * 1024;

/// Something attached to a prompt in the ACP pane.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum AcpAttachment {
    /// An `@`-mentioned or attached file: worktree-relative, or absolute.
    /// Image files go as images when the agent takes them.
    File { path: String },
    /// A pasted image, base64-encoded.
    Image {
        #[serde(rename = "mimeType")]
        mime_type: String,
        data: String,
    },
}

/// Content blocks for `text` + `attachments`, plus a short label per
/// attachment for the transcript. Errors are user-facing.
pub fn build_prompt(
    text: &str,
    attachments: &[AcpAttachment],
    cwd: &Path,
    caps: PromptCaps,
) -> Result<(Vec<Value>, Vec<String>), String> {
    let mut blocks = Vec::new();
    let mut labels = Vec::new();
    let text = text.trim();
    if !text.is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    for a in attachments {
        match a {
            AcpAttachment::File { path } => {
                let abs = if Path::new(path).is_absolute() {
                    Path::new(path).to_path_buf()
                } else {
                    cwd.join(path)
                };
                let meta = std::fs::metadata(&abs)
                    .ok()
                    .filter(|m| m.is_file())
                    .ok_or_else(|| format!("No such file: {path}"))?;
                let label = abs
                    .strip_prefix(cwd)
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| abs.display().to_string());
                if let (Some(mime), true) = (image_mime(&abs), caps.image) {
                    if meta.len() > IMAGE_MAX_BYTES {
                        return Err(format!("{label} is too large to attach (5 MB max)."));
                    }
                    use base64::Engine;
                    let bytes =
                        std::fs::read(&abs).map_err(|e| format!("Couldn't read {label}: {e}"))?;
                    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                    blocks.push(json!({ "type": "image", "mimeType": mime, "data": data, "uri": file_uri(&abs) }));
                    labels.push(format!("@{label}"));
                    continue;
                }
                let uri = file_uri(&abs);
                let contents = (caps.embedded_context && meta.len() <= EMBED_MAX_BYTES)
                    .then(|| std::fs::read_to_string(&abs).ok())
                    .flatten();
                blocks.push(match contents {
                    Some(text) => json!({
                        "type": "resource",
                        "resource": { "uri": uri, "text": text, "mimeType": "text/plain" },
                    }),
                    None => json!({ "type": "resource_link", "uri": uri, "name": label }),
                });
                labels.push(format!("@{label}"));
            }
            AcpAttachment::Image { mime_type, data } => {
                if !caps.image {
                    return Err("This agent doesn't accept images.".into());
                }
                blocks.push(json!({ "type": "image", "mimeType": mime_type, "data": data }));
                labels.push("image".into());
            }
        }
    }
    if blocks.is_empty() {
        return Err("Nothing to send.".into());
    }
    Ok((blocks, labels))
}

/// `file://` URI for an absolute path, percent-encoding what would break
/// one (spaces, `#`, `?`, `%`, non-ASCII).
fn file_uri(path: &Path) -> String {
    let mut out = String::from("file://");
    for b in path.to_string_lossy().bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: PromptCaps = PromptCaps {
        image: true,
        embedded_context: true,
    };

    #[test]
    fn embeds_small_text_files_and_links_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "fn main() {}").unwrap();
        std::fs::write(dir.path().join("big.bin"), vec![0xffu8; 10]).unwrap();
        let atts = [
            AcpAttachment::File {
                path: "src/lib.rs".into(),
            },
            AcpAttachment::File {
                path: "big.bin".into(),
            },
        ];
        let (blocks, labels) = build_prompt(" look ", &atts, dir.path(), ALL).unwrap();
        assert_eq!(blocks[0], json!({ "type": "text", "text": "look" }));
        assert_eq!(blocks[1]["type"], "resource");
        assert_eq!(blocks[1]["resource"]["text"], "fn main() {}");
        assert!(blocks[1]["resource"]["uri"]
            .as_str()
            .unwrap()
            .ends_with("/src/lib.rs"));
        // Not UTF-8: linked, not embedded.
        assert_eq!(blocks[2]["type"], "resource_link");
        assert_eq!(blocks[2]["name"], "big.bin");
        assert_eq!(labels, ["@src/lib.rs", "@big.bin"]);

        // Without embedded-context support, everything is a link.
        let caps = PromptCaps {
            embedded_context: false,
            ..ALL
        };
        let (blocks, _) = build_prompt("x", &atts[..1], dir.path(), caps).unwrap();
        assert_eq!(blocks[1]["type"], "resource_link");
    }

    #[test]
    fn image_files_go_as_images_when_supported() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("shot.PNG"), [0x89, b'P', b'N', b'G']).unwrap();
        let att = [AcpAttachment::File {
            path: "shot.PNG".into(),
        }];
        let (blocks, labels) = build_prompt("", &att, dir.path(), ALL).unwrap();
        assert_eq!(blocks[0]["type"], "image");
        assert_eq!(blocks[0]["mimeType"], "image/png");
        assert_eq!(blocks[0]["data"], "iVBORw==");
        assert_eq!(labels, ["@shot.PNG"]);
        // An agent without image support gets a link instead.
        let caps = PromptCaps {
            image: false,
            ..ALL
        };
        let (blocks, _) = build_prompt("", &att, dir.path(), caps).unwrap();
        assert_eq!(blocks[0]["type"], "resource_link");
    }

    #[test]
    fn images_need_agent_support() {
        let img = [AcpAttachment::Image {
            mime_type: "image/png".into(),
            data: "AAAA".into(),
        }];
        let (blocks, labels) = build_prompt("", &img, Path::new("/"), ALL).unwrap();
        assert_eq!(
            blocks,
            vec![json!({ "type": "image", "mimeType": "image/png", "data": "AAAA" })]
        );
        assert_eq!(labels, ["image"]);
        let caps = PromptCaps {
            image: false,
            ..ALL
        };
        assert!(build_prompt("x", &img, Path::new("/"), caps).is_err());
    }

    #[test]
    fn rejects_missing_files_and_empty_prompts() {
        let dir = tempfile::tempdir().unwrap();
        let missing = [AcpAttachment::File {
            path: "nope.rs".into(),
        }];
        assert_eq!(
            build_prompt("x", &missing, dir.path(), ALL).unwrap_err(),
            "No such file: nope.rs"
        );
        assert!(build_prompt("  ", &[], dir.path(), ALL).is_err());
    }

    #[test]
    fn file_uris_are_encoded() {
        assert_eq!(file_uri(Path::new("/a b/c#1.rs")), "file:///a%20b/c%231.rs");
    }
}
