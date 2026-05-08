/// VS Code-style Problems list, scoped to the **active file** in
/// the editor. Lists every Monaco marker (= LSP diagnostic) for
/// that one file, severity-ordered. Click a row → reveal that
/// position in the editor via the same `setPendingReveal` path
/// goto-definition uses.
///
/// Scoping to the active file matches our LSP model (only the
/// open file is registered with clangd, so "all files" was already
/// effectively "the active file plus whichever others you'd
/// previously visited") and keeps the list short and relevant —
/// you're either reading the diagnostics for what's on screen, or
/// not.
///
/// Renders just the list content; the parent (`BottomPane`) owns
/// the tab strip that switches between Terminal and Problems.

import { useEffect, useMemo, useState } from "react";
import { editor as MonacoEditor, MarkerSeverity } from "monaco-editor";
import type { editor } from "monaco-editor";
import { AlertCircle, AlertTriangle, Info, Lightbulb } from "lucide-react";
import { findMonacoUriForLspUri } from "@/lsp/manager";
import { useDiffsStore } from "@/stores/diffs";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { cn } from "@/lib/cn";

type Row = {
  id: string;
  marker: editor.IMarker;
};

/// Returns the worktree-relative path of the file currently
/// rendered in the editor, plus the workspace-relative model URI
/// for that file (when it has one — the file is only registered
/// with Monaco when EditorPane is mounted on it).
function useActiveFile(): {
  worktreeId: ReturnType<typeof useUiStore.getState>["selectedWorktreeId"];
  relPath: string | null;
  /// `null` when no LSP session has the file open; e.g. you're on
  /// the Diff view and EditorPane never mounted, or the language
  /// has no LSP enabled.
  monacoUri: string | null;
  /// Same `relPath` displayed verbatim — pre-extracted so the row
  /// rendering doesn't have to compute it.
  basename: string | null;
} {
  const worktreeId = useUiStore((s) => s.selectedWorktreeId);
  const selectedFile = useDiffsStore((s) =>
    worktreeId ? s.selectedFile[worktreeId] ?? null : null,
  );
  const worktrees = useWorktreesStore((s) => s.worktrees);
  // `monacoToLspUri` is mutated outside React so a `useState` +
  // marker subscription is the simplest way to re-read it on the
  // events that matter (markers fire when openDocument /
  // closeDocument flip the registration). Cheap.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const sub = MonacoEditor.onDidChangeMarkers(() => setTick((t) => t + 1));
    return () => sub.dispose();
  }, []);

  return useMemo(() => {
    if (!worktreeId || !selectedFile) {
      return { worktreeId, relPath: null, monacoUri: null, basename: null };
    }
    const wt = worktrees.find((w) => w.id === worktreeId);
    if (!wt) {
      return { worktreeId, relPath: selectedFile, monacoUri: null, basename: null };
    }
    const lspUri = `file://${wt.path}/${selectedFile}`;
    const monacoUri = findMonacoUriForLspUri(worktreeId, lspUri);
    const basename = selectedFile.split("/").pop() ?? selectedFile;
    return {
      worktreeId,
      relPath: selectedFile,
      monacoUri,
      basename,
    };
    // `tick` is intentionally a dep — it forces re-resolve when
    // the LSP session map changes (file opens / closes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId, selectedFile, worktrees, tick]);
}

export function ProblemsList() {
  const { worktreeId, relPath, monacoUri, basename } = useActiveFile();
  const [rows, setRows] = useState<Row[]>([]);
  const setView = useDiffsStore((s) => s.setView);
  const setPendingReveal = useDiffsStore((s) => s.setPendingReveal);

  // Subscribe to Monaco's marker changes; refilter on every flip.
  useEffect(() => {
    function refresh() {
      if (!monacoUri) {
        setRows([]);
        return;
      }
      const all = MonacoEditor.getModelMarkers({});
      const filtered = all
        .filter((m) => m.resource.toString() === monacoUri)
        .map((m, i) => ({ id: `${monacoUri}#${i}`, marker: m }));
      // Severity desc, then line.
      filtered.sort((a, b) => {
        if (a.marker.severity !== b.marker.severity) {
          return b.marker.severity - a.marker.severity;
        }
        return a.marker.startLineNumber - b.marker.startLineNumber;
      });
      setRows(filtered);
    }
    refresh();
    const sub = MonacoEditor.onDidChangeMarkers(refresh);
    return () => sub.dispose();
  }, [monacoUri]);

  const counts = useMemo(() => countBySeverity(rows), [rows]);

  function navigate(row: Row) {
    if (!worktreeId || !relPath) return;
    setView(worktreeId, "file");
    setPendingReveal(worktreeId, {
      path: relPath,
      line: row.marker.startLineNumber,
      column: row.marker.startColumn,
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-900 px-3 py-1 font-mono text-[11px] text-neutral-500">
        {basename ? (
          <>
            <span className="text-neutral-300">{basename}</span>
            <span className="text-neutral-600">·</span>
            <span>
              {rows.length === 0
                ? "no diagnostics"
                : `${rows.length} · ${counts.error} ✗ · ${counts.warning} ⚠ · ${counts.info} ⓘ · ${counts.hint} 💡`}
            </span>
          </>
        ) : (
          <span>no file selected</span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {!basename ? (
          <div className="px-3 py-6 text-center text-[11px] text-neutral-500">
            Select a file in the editor to see its diagnostics here.
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-neutral-500">
            {monacoUri
              ? "No diagnostics for this file."
              : "This file isn't open in an LSP session yet — switch to the File tab."}
          </div>
        ) : (
          rows.map((r) => (
            <button
              key={r.id}
              onClick={() => navigate(r)}
              className={cn(
                "flex w-full items-start gap-2 px-3 py-0.5 text-left font-mono text-[11px]",
                "border-l-2 border-transparent",
                "hover:border-blue-700 hover:bg-neutral-950",
              )}
            >
              <SeverityIcon severity={r.marker.severity} />
              <span className="shrink-0 text-neutral-500">
                {r.marker.startLineNumber}:{r.marker.startColumn}
              </span>
              <span
                className="flex-1 truncate text-neutral-300"
                title={r.marker.message}
              >
                {r.marker.message}
              </span>
              <span className="shrink-0 text-[10px] text-neutral-600">
                {[r.marker.source, r.marker.code]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function SeverityIcon({ severity }: { severity: MarkerSeverity }) {
  // Monaco severity values: 8 Error, 4 Warning, 2 Info, 1 Hint.
  if (severity === MarkerSeverity.Error)
    return (
      <AlertCircle size={12} className="mt-[2px] shrink-0 text-rose-400" />
    );
  if (severity === MarkerSeverity.Warning)
    return (
      <AlertTriangle size={12} className="mt-[2px] shrink-0 text-amber-400" />
    );
  if (severity === MarkerSeverity.Info)
    return <Info size={12} className="mt-[2px] shrink-0 text-sky-400" />;
  return <Lightbulb size={12} className="mt-[2px] shrink-0 text-neutral-500" />;
}

function countBySeverity(rows: Row[]): {
  error: number;
  warning: number;
  info: number;
  hint: number;
} {
  let error = 0;
  let warning = 0;
  let info = 0;
  let hint = 0;
  for (const r of rows) {
    switch (r.marker.severity) {
      case MarkerSeverity.Error:
        error++;
        break;
      case MarkerSeverity.Warning:
        warning++;
        break;
      case MarkerSeverity.Info:
        info++;
        break;
      case MarkerSeverity.Hint:
        hint++;
        break;
    }
  }
  return { error, warning, info, hint };
}

/// Marker count for the **active file**, for badge rendering in
/// the bottom-pane tab strip. Subscribes to both Monaco's marker
/// changes and the active-file state so the badge reflects the
/// scoped count, not the global one.
export function useProblemsCount(): number {
  const { monacoUri } = useActiveFile();
  const [count, setCount] = useState(0);
  useEffect(() => {
    function refresh() {
      if (!monacoUri) {
        setCount(0);
        return;
      }
      const n = MonacoEditor.getModelMarkers({}).filter(
        (m) => m.resource.toString() === monacoUri,
      ).length;
      setCount(n);
    }
    refresh();
    const sub = MonacoEditor.onDidChangeMarkers(refresh);
    return () => sub.dispose();
  }, [monacoUri]);
  return count;
}
