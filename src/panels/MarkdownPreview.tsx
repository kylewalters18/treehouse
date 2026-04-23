/// GitHub-flavored markdown preview for `.md` / `.mdx` files.
///
/// Uses `react-markdown` + `remark-gfm` so tables, task lists, strikethrough,
/// and autolinks all render. Styled via Tailwind's `prose` utilities
/// (dark variant), with code fences getting a matching `bg-neutral-950`
/// block to blend with the rest of the editor pane.

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { readFile } from "@/ipc/client";
import { onDiffUpdated } from "@/ipc/client";
import type { FileContent, WorktreeId } from "@/ipc/types";
import { asMessage } from "@/lib/errors";

type Props = {
  worktreeId: WorktreeId;
  path: string;
};

export function MarkdownPreview({ worktreeId, path }: Props) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      try {
        const c = await readFile(worktreeId, path);
        if (!cancelled) setContent(c);
      } catch (e) {
        if (!cancelled) setError(asMessage(e));
      }
    };
    void fetch();

    // Live-refresh on agent writes, same pattern as EditorPane.
    let unlisten: (() => void) | null = null;
    onDiffUpdated(worktreeId, (diff) => {
      if (cancelled) return;
      if (!diff.files.some((f) => f.path === path)) return;
      void fetch();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [worktreeId, path]);

  if (error) {
    return (
      <div className="m-3 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
        {error}
      </div>
    );
  }
  if (!content) return null;
  if (content.binary || content.text === null) {
    return (
      <div className="m-3 rounded border border-neutral-800 bg-neutral-900/60 p-4 text-center text-xs text-neutral-500">
        Cannot preview this file.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-neutral-950 px-6 py-4">
      <article className="prose prose-invert prose-sm max-w-3xl">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {content.text}
        </ReactMarkdown>
      </article>
    </div>
  );
}

/// Same detection as `inferLanguage` uses for Markdown, pulled out so the
/// Preview tab can gate on the file extension without round-tripping
/// through Monaco's language service.
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx");
}
