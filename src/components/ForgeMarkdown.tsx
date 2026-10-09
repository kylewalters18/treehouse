import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { openExternalUrl } from "@/ipc/client";
import type { CommitSummary } from "@/ipc/types";
import { cn } from "@/lib/cn";
import { rehypeCommitRefs, resolveCommitRef } from "@/lib/commit-refs";
import { CodeBlock } from "./CodeBlock";

// Same pipeline as MarkdownPreview minus worktree-relative resolution:
// forge text is remote/user-authored, so raw HTML is always sanitized.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeRaw, rehypeSanitize];

const isAbsolute = (u?: string) => !!u && /^https?:\/\//i.test(u);

const COMPONENTS: Components = {
  a({ href, children, title }) {
    return (
      <a
        href={href}
        title={title ?? href}
        onClick={(e) => {
          // Never let the webview itself navigate away from the app.
          e.preventDefault();
          if (isAbsolute(href)) void openExternalUrl(href!);
        }}
      >
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    // Relative forge uploads need the forge's auth to load; show a
    // placeholder rather than a broken image.
    if (typeof src !== "string" || !isAbsolute(src)) {
      return <span className="text-neutral-500">[image{alt ? `: ${alt}` : ""}]</span>;
    }
    return <img src={src} alt={alt} loading="lazy" />;
  },
  pre({ children }) {
    return (
      <div className="shiki-block">
        <pre className="shiki">{children}</pre>
      </div>
    );
  },
  table({ children }) {
    return (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

/// Fenced code as highlighted, copyable blocks (`codeBlocks` mode). The
/// block renders its own `<pre>`, so the markdown `pre` wrapper is dropped.
const CODE_BLOCK_COMPONENTS: Components = {
  ...COMPONENTS,
  code({ className, children }) {
    const match = /language-(\S+)/.exec(className ?? "");
    const code = String(children ?? "");
    // Inline code has no fence language and no newline.
    if (!match && !code.includes("\n")) return <code>{children}</code>;
    return <CodeBlock code={code.replace(/\n$/, "")} lang={match?.[1]} />;
  },
  pre({ children }) {
    return <>{children}</>;
  },
};

/// Compact GitHub-flavored markdown for issue / MR descriptions — and for
/// agent replies, with `codeBlocks` for highlighted fences + copy buttons.
export function ForgeMarkdown({
  source,
  className,
  codeBlocks = false,
  commitRefs,
}: {
  source: string;
  className?: string;
  codeBlocks?: boolean;
  /// Link hashes naming one of `commits` (see `rehypeCommitRefs`).
  commitRefs?: { commits: CommitSummary[]; onOpen: (commit: CommitSummary) => void };
}) {
  const base = codeBlocks ? CODE_BLOCK_COMPONENTS : COMPONENTS;
  const commits = commitRefs?.commits;
  const onOpen = commitRefs?.onOpen;
  const rehypePlugins = useMemo(
    () =>
      commits?.length
        ? [...REHYPE_PLUGINS, [rehypeCommitRefs, (t: string) => resolveCommitRef(t, commits)]]
        : REHYPE_PLUGINS,
    [commits],
  );
  const components = useMemo(() => {
    if (!commits?.length || !onOpen) return base;
    const bySha = new Map(commits.map((c) => [c.sha, c]));
    return {
      ...base,
      "commit-ref"({ node, children }: { node?: { properties?: { sha?: unknown } }; children?: React.ReactNode }) {
        const commit = bySha.get(String(node?.properties?.sha ?? ""));
        if (!commit) return <>{children}</>;
        return (
          <button
            type="button"
            className="commit-ref"
            title={`${commit.shortSha} ${commit.summary}\nOpen in History`}
            onClick={() => onOpen(commit)}
          >
            {children}
          </button>
        );
      },
    } as Components;
  }, [base, commits, onOpen]);
  return (
    <div className={cn("markdown-body markdown-compact", className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins as typeof REHYPE_PLUGINS}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
