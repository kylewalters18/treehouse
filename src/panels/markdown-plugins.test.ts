import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import {
  imageMime,
  rehypeGithubAlerts,
  resolveLink,
  resolveRelativePath,
} from "./markdown-plugins";

/// Same plugin chain as MarkdownPreview, minus the React component overrides.
function render(md: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm],
      rehypePlugins: [rehypeRaw, rehypeSanitize, rehypeSlug, rehypeGithubAlerts],
      remarkRehypeOptions: { clobberPrefix: "" },
      children: md,
    }),
  );
}

describe("rehypeGithubAlerts", () => {
  it("turns a [!NOTE] blockquote into a titled callout", () => {
    const html = render("> [!NOTE]\n> Useful information.");
    expect(html).toContain('<blockquote class="markdown-alert markdown-alert-note">');
    expect(html).toContain('<p class="markdown-alert-title">Note</p>');
    expect(html).toContain("<p>Useful information.</p>");
    expect(html).not.toContain("[!NOTE]");
  });

  it("handles every kind, case-insensitively", () => {
    for (const kind of ["tip", "important", "warning", "caution"]) {
      expect(render(`> [!${kind.toUpperCase()}]\n> body`)).toContain(`markdown-alert-${kind}`);
    }
    expect(render("> [!warning]\n> body")).toContain("markdown-alert-warning");
  });

  it("drops the paragraph when the marker is followed by a blank line", () => {
    const html = render("> [!TIP]\n>\n> Second paragraph.");
    expect(html).toContain('<p class="markdown-alert-title">Tip</p>');
    expect(html).toContain("<p>Second paragraph.</p>");
    expect(html).not.toMatch(/<p>\s*<\/p>/);
  });

  it("leaves ordinary blockquotes and mid-line markers alone", () => {
    expect(render("> just a quote")).toContain("<blockquote>");
    expect(render("> see [!NOTE] inline")).not.toContain("markdown-alert");
    expect(render("> [!BOGUS]\n> body")).not.toContain("markdown-alert");
  });
});

describe("sanitized raw HTML", () => {
  it("renders safe HTML and strips script", () => {
    const html = render(
      '<details><summary>More</summary>\n\nhidden\n\n</details>\n\n<img src="x.png" onerror="alert(1)">\n\n<script>alert(1)</script>',
    );
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>More</summary>");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
  });

  it("drops javascript: links", () => {
    expect(render("[x](javascript:alert(1))")).not.toContain("javascript:");
  });

  it("keeps fence languages, task lists, and heading slugs", () => {
    const html = render("# Getting Started\n\n```ts\nconst a = 1;\n```\n\n- [x] done");
    expect(html).toContain('<h1 id="getting-started">');
    expect(html).toContain('class="language-ts"');
    expect(html).toContain('class="contains-task-list"');
    expect(html).toContain('type="checkbox"');
  });

  it("links footnotes with a single id prefix", () => {
    const html = render("Text[^1]\n\n[^1]: Note.");
    expect(html).toContain('href="#fn-1"');
    expect(html).toContain('id="user-content-fn-1"');
  });
});

describe("resolveLink", () => {
  it("classifies anchors, external URLs, and other schemes", () => {
    expect(resolveLink("README.md", "#usage")).toEqual({ kind: "anchor", id: "usage" });
    expect(resolveLink("README.md", "https://x.dev/a")).toEqual({
      kind: "external",
      url: "https://x.dev/a",
    });
    expect(resolveLink("README.md", "mailto:a@b.c")).toEqual({ kind: "none" });
  });

  it("resolves relative and root-absolute file links", () => {
    expect(resolveLink("docs/guide/intro.md", "../api.md#auth")).toEqual({
      kind: "file",
      path: "docs/api.md",
      anchor: "auth",
    });
    expect(resolveLink("docs/intro.md", "/src/main.rs")).toEqual({
      kind: "file",
      path: "src/main.rs",
      anchor: null,
    });
    expect(resolveLink("docs/intro.md", "./My%20File.md")).toEqual({
      kind: "file",
      path: "docs/My File.md",
      anchor: null,
    });
  });

  it("refuses paths that escape the worktree", () => {
    expect(resolveLink("README.md", "../outside.md")).toEqual({ kind: "none" });
    expect(resolveRelativePath("a/b.md", "../../x.png")).toBeNull();
  });
});

describe("imageMime", () => {
  it("maps known extensions and falls back", () => {
    expect(imageMime("a/b.SVG")).toBe("image/svg+xml");
    expect(imageMime("shot.jpeg")).toBe("image/jpeg");
    expect(imageMime("weird.xyz")).toBe("application/octet-stream");
  });
});
