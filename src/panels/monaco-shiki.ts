import type { Monaco } from "@monaco-editor/react";
import { createHighlighter, bundledThemes, type ThemeRegistration } from "shiki";
import { shikiToMonaco } from "@shikijs/monaco";
import { EDITOR_CHROME } from "./monaco-theme";

/// Languages handed to Shiki for TextMate-grammar tokenization.
/// `typescript` / `javascript` / `tsx` / `jsx` are deliberately excluded:
/// overriding their tokenizer caused a black-screen on file open in a
/// prior attempt (suspected interaction with Monaco's TS web worker).
/// Monaco's built-in Monarch grammar handles those.
const SHIKI_LANGS = [
  "rust",
  "python",
  "go",
  "c",
  "cpp",
  "ruby",
  "lua",
  "toml",
  "yaml",
  "json",
  "jsonc",
  "markdown",
  "dockerfile",
  "shellscript",
  "bash",
  "sql",
  "html",
  "css",
  "scss",
] as const;

export const SHIKI_THEME_NAME = "treehouse-dark";

let setupPromise: Promise<void> | null = null;

/// Idempotent — first call starts the WASM/grammar load, subsequent calls
/// await the same promise. Must be awaited before any Monaco editor mounts
/// for a Shiki-handled language; otherwise that file's first paint will
/// render with no tokenizer registered.
export function setupShiki(monaco: Monaco): Promise<void> {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    const darkPlusMod = await bundledThemes["dark-plus"]();
    const base = darkPlusMod.default as ThemeRegistration;
    const theme: ThemeRegistration = {
      ...base,
      name: SHIKI_THEME_NAME,
      colors: { ...(base.colors ?? {}), ...EDITOR_CHROME },
    };
    const highlighter = await createHighlighter({
      themes: [theme],
      langs: [...SHIKI_LANGS],
    });
    shikiToMonaco(highlighter, monaco);
  })();
  return setupPromise;
}

export function isShikiLanguage(lang: string): boolean {
  return (SHIKI_LANGS as readonly string[]).includes(lang);
}
