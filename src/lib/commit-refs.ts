/// Commit hashes in agent replies, linked to the History tab. Only hashes
/// naming a commit the History tab lists become links, so hex that merely
/// looks like a hash (colors, IDs, commits off the branch) stays text.

import type { Element, ElementContent, Root, RootContent } from "hast";
import type { CommitSummary } from "@/ipc/types";

const HASH = /\b[0-9a-f]{7,40}\b/gi;

/// The commit `token` abbreviates, if exactly one listed commit has it as
/// a prefix.
export function resolveCommitRef(token: string, commits: CommitSummary[]): CommitSummary | null {
  const t = token.toLowerCase();
  let hit: CommitSummary | null = null;
  for (const c of commits) {
    if (!c.sha.startsWith(t)) continue;
    if (hit) return null;
    hit = c;
  }
  return hit;
}

/// Split `text` into plain runs and resolved commit refs.
export function splitCommitRefs(
  text: string,
  resolve: (token: string) => CommitSummary | null,
): ({ text: string } | { text: string; commit: CommitSummary })[] {
  const out: ({ text: string } | { text: string; commit: CommitSummary })[] = [];
  let last = 0;
  for (const m of text.matchAll(HASH)) {
    const commit = resolve(m[0]);
    if (!commit) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], commit });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/// Rehype plugin: wrap resolved hashes in `<commit-ref sha=…>` elements,
/// outside code blocks and links. Runs after sanitize, which would strip
/// the custom tag.
export function rehypeCommitRefs(resolve: (token: string) => CommitSummary | null) {
  return (tree: Root) => rewrite(tree, resolve);
}

function rewrite(node: Root | Element, resolve: (token: string) => CommitSummary | null) {
  const next: (RootContent | ElementContent)[] = [];
  for (const child of node.children as (RootContent | ElementContent)[]) {
    if (child.type === "element") {
      if (child.tagName !== "pre" && child.tagName !== "a") rewrite(child, resolve);
      next.push(child);
    } else if (child.type === "text") {
      for (const part of splitCommitRefs(child.value, resolve)) {
        next.push(
          "commit" in part
            ? {
                type: "element",
                tagName: "commit-ref",
                properties: { sha: part.commit.sha },
                children: [{ type: "text", value: part.text }],
              }
            : { type: "text", value: part.text },
        );
      }
    } else {
      next.push(child);
    }
  }
  node.children = next as typeof node.children;
}
