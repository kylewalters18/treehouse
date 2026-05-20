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
import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";
import {
  type AppFileKind,
  listLogFiles,
  openLogsFolder,
  readAppTextFile,
  treehouseConfigOpenFile,
  writeAppTextFile,
} from "@/ipc/client";
import { THEME_NAME } from "@/panels/monaco-theme";
import { defineTreehouseTheme } from "@/panels/monaco-theme";
import { cn } from "@/lib/cn";
import { toastError } from "@/stores/toasts";
import { asMessage } from "@/lib/errors";

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
  // Only the config kind is editable; logs stay read-only (writing
  // would race tracing-appender's next emit). `lastSavedContent`
  // tracks what's currently on disk so the Save button can grey out
  // when there's nothing to save.
  const editable = kind === "treehouseConfig";
  const lastSavedRef = useRef("");
  const [dirty, setDirty] = useState(false);

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
        lastSavedRef.current = result.content;
        setDirty(false);
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
  const [editor, setEditor] =
    useState<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const onMount: OnMount = (e, m) => {
    defineTreehouseTheme(m);
    setEditor(e);
  };
  useEffect(() => {
    if (!editor || kind !== "log") return;
    const model = editor.getModel();
    if (!model) return;
    const last = model.getLineCount();
    editor.revealLine(last);
  }, [editor, content, kind]);

  /// Save the current buffer to disk via write_app_text_file. The
  /// conflict-policy plumbing we built for worktree files is overkill
  /// here — the viewer is a short-lived modal that the user opens for
  /// a single edit, so we just write whatever's in the buffer. On
  /// success, refresh the lastSaved snapshot so the dirty dot clears.
  const saveRef = useRef<() => Promise<void>>(async () => {});
  saveRef.current = async () => {
    if (!editable || !editor) return;
    const value = editor.getModel()?.getValue() ?? "";
    try {
      await writeAppTextFile(kind, value);
      lastSavedRef.current = value;
      setContent(value);
      setDirty(false);
    } catch (e: unknown) {
      toastError("Save failed", asMessage(e));
    }
  };

  // Cmd+S → save. Registered via Monaco's command system once per
  // editor mount; the ref indirection above keeps the active save
  // closure live across renders.
  useEffect(() => {
    if (!editable || !editor) return;
    const disposable = editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        void saveRef.current();
      },
    );
    return () => {
      if (
        disposable &&
        typeof disposable === "object" &&
        "dispose" in disposable
      ) {
        (disposable as { dispose: () => void }).dispose();
      }
    };
  }, [editable, editor]);

  // Mirror Monaco model edits into the React `dirty` state so the
  // header button reflects unsaved changes.
  useEffect(() => {
    if (!editable || !editor) return;
    const model = editor.getModel();
    if (!model) return;
    const sub = model.onDidChangeContent(() => {
      setDirty(model.getValue() !== lastSavedRef.current);
    });
    return () => sub.dispose();
  }, [editable, editor, content]);

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
          {editable && (
            <ToolbarButton
              onClick={() => void saveRef.current()}
              title="Save (⌘S)"
              disabled={!dirty}
            >
              {dirty ? "● Save" : "Saved"}
            </ToolbarButton>
          )}
          <ToolbarButton
            onClick={() => {
              if (kind === "log") void openLogsFolder();
              else void treehouseConfigOpenFile();
            }}
            title={
              kind === "log"
                ? "Reveal log folder in Finder"
                : "Open in your OS default .toml handler (VS Code, Sublime, …)"
            }
          >
            {kind === "log" ? "Finder" : "External"}
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
                readOnly: !editable,
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
  disabled,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        "rounded px-2 py-0.5 font-mono text-[11px] text-neutral-300",
        "hover:bg-neutral-800",
        disabled && "cursor-not-allowed text-neutral-600 hover:bg-transparent",
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
    case "treehouseConfig":
      return "treehouse.toml";
  }
}
