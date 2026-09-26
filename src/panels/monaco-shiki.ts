import type { Monaco } from "@monaco-editor/react";
import { createHighlighter, bundledThemes, type ThemeRegistration } from "shiki";
import { shikiToMonaco } from "@shikijs/monaco";

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

/// Editor chrome overrides applied on top of Dark+ — matches the
/// Dark Modern 2026 palette already used elsewhere in the app.
const CHROME: Record<string, string> = {
  "editor.background": "#0F1114",
  "editor.foreground": "#BBBEBF",
  "editorLineNumber.foreground": "#858889",
  "editorLineNumber.activeForeground": "#BBBEBF",
  "editor.lineHighlightBackground": "#1D2126",
  "editor.lineHighlightBorder": "#00000000",
  "editor.selectionBackground": "#276782dd",
  "editor.inactiveSelectionBackground": "#27678260",
  "editor.selectionHighlightBackground": "#27678260",
  "editor.wordHighlightBackground": "#27678250",
  "editor.findMatchBackground": "#27678290",
  "editor.findMatchHighlightBackground": "#27678280",
  "editorCursor.foreground": "#BBBEBF",
  "editorIndentGuide.background1": "#8384854D",
  "editorIndentGuide.activeBackground1": "#838485",
  "editorWhitespace.foreground": "#8C8C8C4D",
  "editorBracketMatch.background": "#3994BC55",
  "editorBracketMatch.border": "#22262BFF",
  "editorGutter.background": "#0F1114",
  "editorOverviewRuler.border": "#22262BFF",
  "scrollbar.shadow": "#191B1D4D",
  "scrollbarSlider.background": "#83848533",
  "scrollbarSlider.hoverBackground": "#83848566",
  "scrollbarSlider.activeBackground": "#83848599",
  "editorWidget.background": "#1A1D21",
  "editorWidget.border": "#22262BFF",
  "editorSuggestWidget.background": "#1A1D21",
  "editorSuggestWidget.border": "#22262BFF",
  "editorSuggestWidget.foreground": "#bfbfbf",
  "editorSuggestWidget.selectedBackground": "#3994BC26",
  "editorHoverWidget.background": "#1A1D21",
  "editorHoverWidget.border": "#22262BFF",
  "input.background": "#16191D",
  "input.border": "#2C3137FF",
  focusBorder: "#3994BCB3",
  "diffEditor.insertedLineBackground": "#347d3926",
  "diffEditor.insertedTextBackground": "#57ab5a4d",
  "diffEditor.removedLineBackground": "#c93c3726",
  "diffEditor.removedTextBackground": "#f470674d",
};

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
      colors: { ...(base.colors ?? {}), ...CHROME },
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
