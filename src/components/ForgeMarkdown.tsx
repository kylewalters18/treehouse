import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { openExternalUrl } from "@/ipc/client";
import { cn } from "@/lib/cn";

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

/// Compact GitHub-flavored markdown for issue / MR descriptions.
export function ForgeMarkdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  return (
    <div className={cn("markdown-body markdown-compact", className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
