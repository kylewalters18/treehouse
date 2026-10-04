/// Pure helpers for the markdown preview: a rehype plugin for GitHub
/// alert blockquotes and worktree-relative link/image resolution. Kept
/// out of MarkdownPreview.tsx so they're unit-testable without a DOM.

import type { Element, ElementContent, Root, RootContent } from "hast";

const ALERT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
type AlertKind = (typeof ALERT_KINDS)[number];

const ALERT_MARKER = /^\s*\[!(note|tip|important|warning|caution)\][ \t]*(\r?\n|$)/i;

/// GitHub alerts: a blockquote whose first line is exactly `[!NOTE]`
/// (or TIP / IMPORTANT / WARNING / CAUTION) becomes a callout. Rewrites
/// the blockquote in place — strips the marker, adds
/// `markdown-alert markdown-alert-<kind>`, and prepends a title line.
/// Runs after sanitize so the classes it adds survive.
export function rehypeGithubAlerts() {
  return (tree: Root) => {
    walk(tree, (el) => {
      if (el.tagName === "blockquote") convertAlert(el);
    });
  };
}

function walk(node: Root | Element, visit: (el: Element) => void) {
  for (const child of node.children as (RootContent | ElementContent)[]) {
    if (child.type === "element") {
      visit(child);
      walk(child, visit);
    }
  }
}

function convertAlert(quote: Element) {
  const para = quote.children.find(
    (c): c is Element => c.type === "element",
  );
  if (!para || para.tagName !== "p") return;
  const first = para.children[0];
  if (!first || first.type !== "text") return;
  const m = ALERT_MARKER.exec(first.value);
  if (!m) return;
  const kind = m[1].toLowerCase() as AlertKind;

  first.value = first.value.slice(m[0].length);
  // `[!NOTE]` alone on its line followed by a soft break leaves a
  // leading `<br>` / empty text; drop those so the body starts flush.
  while (
    para.children.length > 0 &&
    ((para.children[0].type === "text" && para.children[0].value.trim() === "") ||
      (para.children[0].type === "element" && para.children[0].tagName === "br"))
  ) {
    para.children.shift();
  }
  if (para.children.length === 0) {
    quote.children.splice(quote.children.indexOf(para), 1);
  }

  quote.properties = {
    ...quote.properties,
    className: ["markdown-alert", `markdown-alert-${kind}`],
  };
  quote.children.unshift({
    type: "element",
    tagName: "p",
    properties: { className: ["markdown-alert-title"] },
    children: [{ type: "text", value: kind[0].toUpperCase() + kind.slice(1) }],
  });
}

export type LinkTarget =
  | { kind: "anchor"; id: string }
  | { kind: "external"; url: string }
  | { kind: "file"; path: string; anchor: string | null }
  | { kind: "none" };

/// Classify an `href` from a markdown file at `fromPath` (worktree
/// relative). Relative paths resolve against the file's directory and a
/// leading `/` against the worktree root, matching how GitHub renders
/// repo markdown. Anything escaping the worktree resolves to `none`.
export function resolveLink(fromPath: string, href: string): LinkTarget {
  if (href.startsWith("#")) return { kind: "anchor", id: decode(href.slice(1)) };
  if (/^https?:\/\//i.test(href)) return { kind: "external", url: href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: "none" };
  const hashAt = href.indexOf("#");
  const anchor = hashAt >= 0 ? decode(href.slice(hashAt + 1)) : null;
  const bare = (hashAt >= 0 ? href.slice(0, hashAt) : href).split("?")[0];
  const path = resolveRelativePath(fromPath, bare);
  return path ? { kind: "file", path, anchor } : { kind: "none" };
}

/// Resolve a relative (or root-absolute) reference against the directory
/// of `fromPath`. Returns `null` if it's empty or climbs above the root.
export function resolveRelativePath(fromPath: string, ref: string): string | null {
  if (ref === "") return null;
  const parts = ref.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
  for (const seg of decode(ref).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/// MIME type for an image path by extension. SVG needs the explicit type
/// or a Blob URL won't render it in an `<img>`.
export function imageMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return IMAGE_MIME[ext] ?? "application/octet-stream";
}

/// True for raster image formats the File view renders as a picture
/// instead of a "binary file" placeholder. SVG is excluded: it's text,
/// so it stays editable in Monaco.
export function isRasterImagePath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ext !== "svg" && ext in IMAGE_MIME;
}
