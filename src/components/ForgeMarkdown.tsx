import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { openExternalUrl } from "@/ipc/client";
import { cn } from "@/lib/cn";
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
}: {
  source: string;
  className?: string;
  codeBlocks?: boolean;
}) {
  return (
    <div className={cn("markdown-body markdown-compact", className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={codeBlocks ? CODE_BLOCK_COMPONENTS : COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
