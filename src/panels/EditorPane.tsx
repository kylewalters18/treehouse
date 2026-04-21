import { useEffect, useMemo, useState } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import { readFile } from "@/ipc/client";
import type { FileContent, WorktreeId } from "@/ipc/types";

/// Custom Monaco theme: inherits `vs-dark`'s syntax token colors but overrides
/// backgrounds, gutters, selection, and scrollbars to match the app's neutral
/// palette (neutral-950/900/800) so the editor doesn't feel like a foreign
/// iframe.
const THEME_NAME = "treehouse-dark";

function defineTreehouseTheme(monaco: Monaco) {
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
      "focusBorder": "#2563eb",
    },
  });
}

type Props = {
  worktreeId: WorktreeId;
  path: string | null;
};

export function EditorPane({ worktreeId, path }: Props) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setContent(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    readFile(worktreeId, path)
      .then((c) => {
        if (!cancelled) {
          setContent(c);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(asMessage(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [worktreeId, path]);

  const language = useMemo(() => (path ? inferLanguage(path) : "plaintext"), [path]);

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-neutral-600">
        Pick a file on the left to view its contents
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-neutral-600">
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="m-3 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
        {error}
      </div>
    );
  }
  if (!content) return null;

  if (content.binary) {
    return (
      <div className="m-3 rounded border border-neutral-800 bg-neutral-900/60 p-4 text-center text-xs text-neutral-500">
        Binary file — {(Number(content.size) / 1024).toFixed(1)} KB
      </div>
    );
  }
  if (content.text === null) {
    return (
      <div className="m-3 rounded border border-neutral-800 bg-neutral-900/60 p-4 text-center text-xs text-neutral-500">
        File too large to preview ({(Number(content.size) / 1024 / 1024).toFixed(1)} MB)
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-neutral-950">
      <Editor
        height="100%"
        language={language}
        value={content.text}
        theme={THEME_NAME}
        beforeMount={defineTreehouseTheme}
        path={path}
        options={{
          readOnly: true,
          minimap: { enabled: false },
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 18,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          renderWhitespace: "none",
          renderLineHighlight: "line",
          tabSize: 2,
          padding: { top: 8, bottom: 8 },
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
          },
          overviewRulerBorder: false,
          overviewRulerLanes: 0,
          guides: {
            indentation: true,
            highlightActiveIndentation: false,
          },
        }}
      />
    </div>
  );
}

export function inferLanguage(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".d.ts")) return "typescript";
  const ext = lower.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    rs: "rust",
    py: "python",
    go: "go",
    java: "java",
    kt: "kotlin",
    rb: "ruby",
    c: "c",
    cpp: "cpp",
    cc: "cpp",
    h: "cpp",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    md: "markdown",
    mdx: "markdown",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    toml: "plaintext",
    sh: "shell",
    zsh: "shell",
    bash: "shell",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    dockerfile: "dockerfile",
    graphql: "graphql",
    vue: "html",
    svelte: "html",
  };
  return map[ext] ?? "plaintext";
}

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return e instanceof Error ? e.message : String(e);
}
