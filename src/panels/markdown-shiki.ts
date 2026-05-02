/// Shiki highlighter dedicated to the markdown preview. Kept separate
/// from `monaco-shiki.ts` because that one calls `shikiToMonaco`,
/// which registers every loaded language with Monaco's tokenizer —
/// adding TS/JS/TSX/JSX there caused a black-screen on file open in
/// the editor (see SHIKI_LANGS comment in monaco-shiki.ts). The
/// markdown preview never touches Monaco, so a separate highlighter
/// can include those without risk.
///
/// The highlighter is a module-scope promise so the cost is paid once
/// per app session and `MarkdownPreview` can await it on mount.

import { createHighlighter, bundledThemes, type Highlighter, type ThemeRegistration } from "shiki";

/// Languages we expect to see in markdown code fences. Heavier than
/// strictly necessary but the tokenization grammars are small; the
/// real cost is the one-time WASM load which is amortized across all
/// languages.
const LANGS = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "rust",
  "python",
  "go",
  "c",
  "cpp",
  "ruby",
  "lua",
  "java",
  "kotlin",
  "swift",
  "toml",
  "yaml",
  "json",
  "jsonc",
  "markdown",
  "dockerfile",
  "shellscript",
  "bash",
  "sh",
  "zsh",
  "fish",
  "sql",
  "html",
  "css",
  "scss",
  "diff",
  "xml",
  "graphql",
  "ini",
] as const;

const THEME_NAME = "treehouse-dark-md";

let highlighterPromise: Promise<Highlighter> | null = null;

export function getMarkdownHighlighter(): Promise<Highlighter> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    const darkPlusMod = await bundledThemes["dark-plus"]();
    const base = darkPlusMod.default as ThemeRegistration;
    const theme: ThemeRegistration = {
      ...base,
      name: THEME_NAME,
      // Match the markdown-preview surface so highlighted blocks blend
      // into the page rather than punching out a different background.
      colors: {
        ...(base.colors ?? {}),
        "editor.background": "#0e0f10",
      },
    };
    return await createHighlighter({
      themes: [theme],
      langs: [...LANGS],
    });
  })();
  return highlighterPromise;
}

/// Highlight a single code-fence to HTML. Falls back to a `<pre><code>`
/// passthrough when the language isn't in our load set rather than
/// throwing, so an exotic fence doesn't blow up the entire preview.
export function highlightCode(
  highlighter: Highlighter,
  code: string,
  lang: string,
): string {
  const supported = (LANGS as readonly string[]).includes(lang);
  if (!supported) return passthroughHtml(code);
  try {
    return highlighter.codeToHtml(code, { lang, theme: THEME_NAME });
  } catch {
    return passthroughHtml(code);
  }
}

function passthroughHtml(code: string): string {
  const escaped = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<pre class="shiki"><code>${escaped}</code></pre>`;
}
