/// In-app viewer for app-managed system files (logs, override
/// TOMLs). Modal Monaco editor in read-only mode with a header
/// showing the absolute path and three actions: Refresh, Reveal in
/// Finder, Open in default editor. Editing happens out-of-app
/// because our write-back path isn't generic; the viewer covers the
/// "what does the file say right now?" use case which is the common
/// one.
///
/// For logs, the kind picker doubles as a file picker — daily-
/// rotated files surface as a dropdown ordered newest-first.

import { useEffect, useMemo, useRef, useState } from "react";
import { Editor, type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import {
  type AppFileKind,
  listLogFiles,
  lspOpenOverridesFile,
  openLogsFolder,
  readAppTextFile,
} from "@/ipc/client";
import { THEME_NAME } from "@/panels/monaco-theme";
import { defineTreehouseTheme } from "@/panels/monaco-theme";
import { cn } from "@/lib/cn";

type Props = {
  open: boolean;
  onClose: () => void;
  /// Which file the viewer is targeting. `"log"` reveals the file
  /// picker for daily-rotated entries; the rest are single files.
  kind: AppFileKind;
};

export function SystemFileViewer({ open, onClose, kind }: Props) {
  const [path, setPath] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // For `kind === "log"`: the list of available files + the one
  // currently rendered. `null` selectedLog means "show the latest".
  const [logFiles, setLogFiles] = useState<string[]>([]);
  const [selectedLog, setSelectedLog] = useState<string | null>(null);

  const language = useMemo<string>(() => {
    if (kind === "log") return "log";
    return "toml";
  }, [kind]);

  const refresh = useMemo(() => {
    return async () => {
      setLoading(true);
      setError(null);
      try {
        if (kind === "log") {
          const files = await listLogFiles();
          setLogFiles(files);
          // Reset selection if the previously-selected file rotated
          // out (rare but possible across day boundaries).
          if (selectedLog && !files.includes(selectedLog)) {
            setSelectedLog(null);
          }
        }
        const result = await readAppTextFile(
          kind,
          kind === "log" ? selectedLog ?? undefined : undefined,
        );
        setPath(result.path);
        setContent(result.content);
      } catch (e: unknown) {
        const msg =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
        setError(msg);
      } finally {
        setLoading(false);
      }
    };
  }, [kind, selectedLog]);

  // Load on open + whenever the kind/selected log changes.
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  // Esc closes; Cmd+R refreshes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        void refresh();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, refresh]);

  // For logs, scroll to the bottom on each load so users see the
  // most recent lines first. Other file kinds open at the top.
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const onMount: OnMount = (editor, monaco) => {
    defineTreehouseTheme(monaco);
    editorRef.current = editor;
  };
  useEffect(() => {
    if (!editorRef.current || kind !== "log") return;
    const model = editorRef.current.getModel();
    if (!model) return;
    const last = model.getLineCount();
    editorRef.current.revealLine(last);
  }, [content, kind]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-12"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-[1000px] max-w-[95vw] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-2">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">
            {labelFor(kind)}
          </span>
          <span className="truncate font-mono text-[11px] text-neutral-400" title={path}>
            {path || "(no file yet)"}
          </span>
          <div className="flex-1" />
          {kind === "log" && logFiles.length > 0 && (
            <select
              value={selectedLog ?? ""}
              onChange={(e) => setSelectedLog(e.target.value || null)}
              className="rounded border border-neutral-800 bg-neutral-950 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300"
              title="Pick a daily-rotated log file"
            >
              <option value="">latest</option>
              {logFiles.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
          <ToolbarButton onClick={() => void refresh()} title="Refresh (⌘R)">
            ↻
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              if (kind === "log") void openLogsFolder();
              else void lspOpenOverridesFile();
            }}
            title={
              kind === "log"
                ? "Reveal log folder in Finder"
                : "Open in default editor"
            }
          >
            {kind === "log" ? "Finder" : "Edit"}
          </ToolbarButton>
          <ToolbarButton onClick={onClose} title="Close (Esc)">
            ✕
          </ToolbarButton>
        </header>
        <div className="flex-1 overflow-hidden bg-neutral-950">
          {error ? (
            <div className="m-3 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          ) : loading && !content ? (
            <div className="flex h-full items-center justify-center text-xs text-neutral-600">
              Loading…
            </div>
          ) : (
            <Editor
              key={kind + (selectedLog ?? "")}
              height="100%"
              language={language}
              value={content || "(empty — file does not exist yet)"}
              theme={THEME_NAME}
              onMount={onMount}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontFamily:
                  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                fontSize: 12,
                lineHeight: 18,
                glyphMargin: false,
                scrollBeyondLastLine: false,
                renderWhitespace: "none",
                renderLineHighlight: "none",
                wordWrap: kind === "log" ? "on" : "off",
                padding: { top: 8, bottom: 8 },
                scrollbar: {
                  verticalScrollbarSize: 10,
                  horizontalScrollbarSize: 10,
                },
                overviewRulerBorder: false,
                overviewRulerLanes: 0,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "rounded px-2 py-0.5 font-mono text-[11px] text-neutral-300",
        "hover:bg-neutral-800",
      )}
    >
      {children}
    </button>
  );
}

function labelFor(kind: AppFileKind): string {
  switch (kind) {
    case "log":
      return "log";
    case "lspOverrides":
      return "lsp overrides";
    case "workspaceSetup":
      return "workspace setup";
    case "languages":
      return "languages";
  }
}
