import type { Monaco } from "@monaco-editor/react";

/// Shared Monaco theme used by both the file editor (EditorPane) and the
/// diff viewer (DiffEditorView): Dark+ token colors over the treehouse
/// chrome ladder.
export const THEME_NAME = "treehouse-dark";

/// Editor chrome colors, shared by this Monarch fallback theme and the
/// Shiki theme (monaco-shiki.ts) so the two can't drift. Every value is a
/// Tailwind token from tailwind.config.js — neutral ladder for surfaces,
/// `blue-*` as the single accent, emerald / amber / rose for git status
/// and diagnostics, matching the rest of the UI.
export const EDITOR_CHROME: Record<string, string> = {
  // Surfaces: editor sits on neutral-950; the active line lifts to 900.
  "editor.background": "#0F1114",
  "editor.foreground": "#BEC3CA",
  "editorGutter.background": "#0F1114",
  "editor.lineHighlightBackground": "#16191D",
  "editor.lineHighlightBorder": "#00000000",
  "editorLineNumber.foreground": "#555C65",
  "editorLineNumber.activeForeground": "#B4BAC2",
  "editorCursor.foreground": "#6AA1FF",

  // Selection / highlights — all blue accent at varying strength.
  "editor.selectionBackground": "#3874E059",
  "editor.inactiveSelectionBackground": "#3874E02E",
  "editor.selectionHighlightBackground": "#4F8CF526",
  "editor.wordHighlightBackground": "#4F8CF51F",
  "editor.wordHighlightStrongBackground": "#4F8CF533",
  "editor.findMatchBackground": "#4F8CF566",
  "editor.findMatchBorder": "#6AA1FF",
  "editor.findMatchHighlightBackground": "#4F8CF52E",
  "editor.findRangeHighlightBackground": "#16191D",
  "editor.hoverHighlightBackground": "#4F8CF51A",
  "editor.rangeHighlightBackground": "#16191D",
  "editorBracketMatch.background": "#4F8CF526",
  "editorBracketMatch.border": "#4F8CF580",
  "editorLink.activeForeground": "#6AA1FF",

  // Hairlines: guides and rulers sit on the 800/700 steps.
  "editorIndentGuide.background1": "#22262B",
  "editorIndentGuide.activeBackground1": "#2C3137",
  "editorWhitespace.foreground": "#555C6566",
  "editorRuler.foreground": "#22262B",
  "editorCodeLens.foreground": "#7D858F",
  "editorOverviewRuler.border": "#00000000",

  // Git gutter + diagnostics follow the status colors used in the
  // file tree / Changes list (emerald-400 / amber-400 / rose-400).
  "editorGutter.addedBackground": "#34D399",
  "editorGutter.modifiedBackground": "#FBBF24",
  "editorGutter.deletedBackground": "#FB7185",
  "editorError.foreground": "#FB7185",
  "editorWarning.foreground": "#FBBF24",
  "editorInfo.foreground": "#6AA1FF",

  // Flat scrollbars — no drop shadow, neutral-500 thumb.
  "scrollbar.shadow": "#00000000",
  "scrollbarSlider.background": "#7D858F26",
  "scrollbarSlider.hoverBackground": "#7D858F4D",
  "scrollbarSlider.activeBackground": "#7D858F73",
  "minimapSlider.background": "#7D858F26",
  "minimapSlider.hoverBackground": "#7D858F4D",
  "minimapSlider.activeBackground": "#7D858F73",

  // Widgets (find, suggest, hover, peek) are raised 900 cards with a
  // 700 border, like the app's popovers.
  "widget.shadow": "#0000007A",
  "editorWidget.background": "#16191D",
  "editorWidget.border": "#2C3137",
  "editorWidget.foreground": "#D0D4D9",
  "editorSuggestWidget.background": "#16191D",
  "editorSuggestWidget.border": "#2C3137",
  "editorSuggestWidget.foreground": "#B4BAC2",
  "editorSuggestWidget.highlightForeground": "#6AA1FF",
  "editorSuggestWidget.focusHighlightForeground": "#98BDFF",
  "editorSuggestWidget.selectedForeground": "#F4F5F7",
  "editorSuggestWidget.selectedBackground": "#3874E033",
  "editorHoverWidget.background": "#16191D",
  "editorHoverWidget.border": "#2C3137",
  "list.hoverBackground": "#22262B",
  "list.activeSelectionBackground": "#3874E033",
  "list.activeSelectionForeground": "#F4F5F7",
  "list.highlightForeground": "#6AA1FF",
  "input.background": "#0F1114",
  "input.foreground": "#D0D4D9",
  "input.border": "#2C3137",
  "input.placeholderForeground": "#555C65",
  "inputOption.activeBorder": "#4F8CF5",
  "inputOption.activeBackground": "#3874E033",
  focusBorder: "#4F8CF599",

  // Diff: low-alpha emerald / rose washes; collapsed unchanged regions
  // drop to the chrome surface.
  "diffEditor.insertedLineBackground": "#34D39912",
  "diffEditor.insertedTextBackground": "#34D39933",
  "diffEditor.removedLineBackground": "#FB718512",
  "diffEditor.removedTextBackground": "#FB718533",
  "diffEditorGutter.insertedLineBackground": "#34D3991F",
  "diffEditorGutter.removedLineBackground": "#FB71851F",
  "diffEditor.border": "#22262B",
  "diffEditor.unchangedRegionBackground": "#0B0C0E",
  "diffEditor.unchangedRegionForeground": "#7D858F",
  "diffEditor.unchangedCodeBackground": "#00000000",
};

export function defineTreehouseTheme(monaco: Monaco) {
  monaco.editor.defineTheme(THEME_NAME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6A9955", fontStyle: "italic" },
      { token: "comment.doc", foreground: "6A9955", fontStyle: "italic" },

      { token: "string", foreground: "CE9178" },
      { token: "string.escape", foreground: "D7BA7D" },
      { token: "string.key.json", foreground: "9CDCFE" },
      { token: "string.value.json", foreground: "CE9178" },
      { token: "regexp", foreground: "D16969" },

      { token: "keyword", foreground: "569CD6" },
      { token: "keyword.flow", foreground: "C586C0" },
      { token: "keyword.json", foreground: "569CD6" },
      { token: "keyword.operator", foreground: "D4D4D4" },
      { token: "storage", foreground: "569CD6" },
      { token: "storage.type", foreground: "569CD6" },

      { token: "number", foreground: "B5CEA8" },
      { token: "number.hex", foreground: "B5CEA8" },
      { token: "number.float", foreground: "B5CEA8" },
      { token: "constant", foreground: "4FC1FF" },
      { token: "constant.language", foreground: "569CD6" },

      { token: "type", foreground: "4EC9B0" },
      { token: "type.identifier", foreground: "4EC9B0" },
      { token: "namespace", foreground: "4EC9B0" },
      { token: "annotation", foreground: "DCDCAA" },

      { token: "identifier", foreground: "9CDCFE" },
      { token: "variable", foreground: "9CDCFE" },
      { token: "variable.parameter", foreground: "9CDCFE" },
      { token: "variable.predefined", foreground: "4FC1FF" },

      { token: "function", foreground: "DCDCAA" },
      { token: "support.function", foreground: "DCDCAA" },

      { token: "operator", foreground: "D4D4D4" },
      { token: "delimiter", foreground: "D4D4D4" },
      { token: "delimiter.bracket", foreground: "D4D4D4" },
      { token: "delimiter.parenthesis", foreground: "D4D4D4" },
      { token: "delimiter.square", foreground: "D4D4D4" },
      { token: "delimiter.curly", foreground: "D4D4D4" },

      { token: "tag", foreground: "569CD6" },
      { token: "tag.id", foreground: "569CD6" },
      { token: "metatag", foreground: "569CD6" },
      { token: "attribute.name", foreground: "9CDCFE" },
      { token: "attribute.value", foreground: "CE9178" },

      { token: "key", foreground: "9CDCFE" },
      { token: "type.yaml", foreground: "9CDCFE" },
      { token: "string.yaml", foreground: "CE9178" },
    ],
    colors: EDITOR_CHROME,
  });
}
