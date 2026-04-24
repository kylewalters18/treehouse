import type { Monaco } from "@monaco-editor/react";

/// Shared Monaco theme used by both the file editor (EditorPane) and the
/// diff viewer (DiffEditorView). Inherits `vs-dark`'s syntax token colors
/// but overrides backgrounds, gutters, selection, and scrollbars to match
/// the app's neutral palette.
export const THEME_NAME = "treehouse-dark";

export function defineTreehouseTheme(monaco: Monaco) {
  monaco.editor.defineTheme(THEME_NAME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#0a0a0a",
      "editor.foreground": "#e5e5e5",
      "editorLineNumber.foreground": "#525252",
      "editorLineNumber.activeForeground": "#a3a3a3",
      "editor.lineHighlightBackground": "#171717",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#2563eb55",
      "editor.inactiveSelectionBackground": "#2563eb22",
      "editor.wordHighlightBackground": "#ffffff10",
      "editor.findMatchBackground": "#f59e0b66",
      "editor.findMatchHighlightBackground": "#f59e0b33",
      "editorCursor.foreground": "#e5e5e5",
      "editorIndentGuide.background1": "#1f1f1f",
      "editorIndentGuide.activeBackground1": "#333333",
      "editorWhitespace.foreground": "#262626",
      "editorBracketMatch.background": "#2563eb33",
      "editorBracketMatch.border": "#2563eb66",
      "editorGutter.background": "#0a0a0a",
      "editorOverviewRuler.border": "#00000000",
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": "#52525280",
      "scrollbarSlider.hoverBackground": "#525252c0",
      "scrollbarSlider.activeBackground": "#737373",
      "editorWidget.background": "#0f0f0f",
      "editorWidget.border": "#262626",
      "editorSuggestWidget.background": "#0f0f0f",
      "editorSuggestWidget.border": "#262626",
      "editorSuggestWidget.foreground": "#e5e5e5",
      "editorSuggestWidget.selectedBackground": "#262626",
      "input.background": "#171717",
      "input.border": "#262626",
      focusBorder: "#2563eb",
      // Diff-editor specific: tone down the default green/red backgrounds
      // since they clash with the app's dark neutral palette.
      "diffEditor.insertedTextBackground": "#10b98122",
      "diffEditor.removedTextBackground": "#f43f5e22",
      "diffEditor.insertedLineBackground": "#10b98111",
      "diffEditor.removedLineBackground": "#f43f5e11",
    },
  });
}
