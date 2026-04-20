import { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { readFile } from "@/ipc/client";
import type { FileContent, WorktreeId } from "@/ipc/types";

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
    <div className="h-full w-full">
      <Editor
        height="100%"
        language={language}
        value={content.text}
        theme="vs-dark"
        path={path}
        options={{
          readOnly: true,
          minimap: { enabled: false },
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          fontSize: 12,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          renderWhitespace: "none",
          tabSize: 2,
        }}
      />
    </div>
  );
}

function inferLanguage(path: string): string {
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
