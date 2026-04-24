import { useEffect, useMemo, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { useDiffsStore } from "@/stores/diffs";
import { useLspStore } from "@/stores/lsp";
import { onDiffUpdated, readBlobAtRef, readFile } from "@/ipc/client";
import type { FileDiff, FileStatus, WorktreeId } from "@/ipc/types";
import { cn } from "@/lib/cn";
import { EditorPane } from "./EditorPane";
import { FileTree } from "./FileTree";
import { MarkdownPreview, isMarkdownPath } from "./MarkdownPreview";
import { inferLanguage } from "./editor-language";
import { THEME_NAME, defineTreehouseTheme } from "./monaco-theme";

export function DiffPane() {
  const worktreeId = useUiStore((s) => s.selectedWorktreeId);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const worktree = useMemo(
    () => worktrees.find((w) => w.id === worktreeId) ?? null,
    [worktrees, worktreeId],
  );

  if (!worktree) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-neutral-600">
        Select a worktree to see its diff
      </div>
    );
  }

  return <DiffView worktreeId={worktree.id} />;
}

function DiffView({ worktreeId }: { worktreeId: WorktreeId }) {
  const diff = useDiffsStore((s) => s.byWorktree[worktreeId]);
  const error = useDiffsStore((s) => s.error[worktreeId]);
  const selectedFile = useDiffsStore((s) => s.selectedFile[worktreeId] ?? null);
  const view = useDiffsStore((s) => s.view[worktreeId] ?? "diff");
  const fetchDiff = useDiffsStore((s) => s.fetch);
  const setDiff = useDiffsStore((s) => s.set);
  const selectFile = useDiffsStore((s) => s.selectFile);
  const setView = useDiffsStore((s) => s.setView);
  const [treeRefresh, setTreeRefresh] = useState(0);
  const [showIgnored, setShowIgnored] = useState(false);

  useEffect(() => {
    fetchDiff(worktreeId);
    const p = onDiffUpdated(worktreeId, (d) => {
      setDiff(worktreeId, d);
      setTreeRefresh((n) => n + 1);
    });
    return () => {
      p.then((fn) => fn()).catch(() => {});
    };
  }, [worktreeId, fetchDiff, setDiff]);

  const statusByPath = useMemo<Map<string, FileStatus>>(() => {
    const m = new Map<string, FileStatus>();
    if (diff) {
      for (const f of diff.files) m.set(f.path, f.status);
    }
    return m;
  }, [diff]);

  const selected: FileDiff | null = useMemo(() => {
    if (!diff || !selectedFile) return null;
    return diff.files.find((f) => f.path === selectedFile) ?? null;
  }, [diff, selectedFile]);

  // If the user picks a file from the tree that isn't in the diff, force
  // a non-diff view since there's no diff to show. "file" and "preview"
  // are both valid non-diff views — only force when the current view is
  // actually "diff", otherwise a freshly-selected Preview tab gets
  // clobbered back to File on the next render.
  useEffect(() => {
    if (!selectedFile) return;
    const inDiff = diff?.files.some((f) => f.path === selectedFile) ?? false;
    if (!inDiff && view === "diff") setView(worktreeId, "file");
  }, [selectedFile, diff, view, worktreeId, setView]);

  if (error) {
    return (
      <div className="m-3 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-72 flex-col border-r border-neutral-800">
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-900 px-3 py-2 text-[11px] uppercase tracking-wider text-neutral-500">
          <span>Changes ({diff?.stats.filesChanged ?? 0})</span>
          {diff && (
            <span className="font-mono text-[11px]">
              <span className="text-emerald-400">+{diff.stats.insertions}</span>{" "}
              <span className="text-rose-400">-{diff.stats.deletions}</span>
            </span>
          )}
        </div>
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-neutral-900">
          {!diff || diff.files.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-neutral-600">
              {diff
                ? `No changes against ${diff.baseRef.slice(0, 8)}`
                : "Computing diff…"}
            </div>
          ) : (
            <ul>
              {diff.files.map((f) => (
                <li key={f.path}>
                  <button
                    onClick={() => {
                      selectFile(worktreeId, f.path);
                      setView(worktreeId, "diff");
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1 text-left text-xs hover:bg-neutral-900",
                      selectedFile === f.path && "bg-neutral-900",
                    )}
                    title={f.path}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <StatusBadge status={f.status} />
                      <span className="truncate font-mono text-[11px] text-neutral-200">
                        {f.path}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[11px]">
                      <span className="text-emerald-400">+{f.insertions}</span>{" "}
                      <span className="text-rose-400">-{f.deletions}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-900 px-3 py-2 text-[11px] uppercase tracking-wider text-neutral-500">
          <span>Files</span>
          <button
            onClick={() => setShowIgnored((v) => !v)}
            title={
              showIgnored
                ? "Hide gitignored files"
                : "Show gitignored files (dimmed)"
            }
            className={cn(
              "rounded px-1 font-mono text-[10px] normal-case tracking-normal transition",
              showIgnored
                ? "bg-neutral-800 text-neutral-200"
                : "text-neutral-600 hover:bg-neutral-900 hover:text-neutral-300",
            )}
          >
            {showIgnored ? "◉ ignored" : "○ ignored"}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <FileTree
            worktreeId={worktreeId}
            statusByPath={statusByPath}
            selectedPath={selectedFile}
            onSelect={(path) => selectFile(worktreeId, path)}
            refreshToken={treeRefresh}
            showIgnored={showIgnored}
          />
        </div>
      </aside>
      <section className="flex flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-950 px-2 py-1 text-[11px]">
          <TabButton
            active={view === "diff"}
            onClick={() => setView(worktreeId, "diff")}
            disabled={!selected}
          >
            Diff
          </TabButton>
          <TabButton
            active={view === "file"}
            onClick={() => setView(worktreeId, "file")}
            disabled={
              !selectedFile ||
              (selected?.binary ?? false) ||
              selected?.status.kind === "deleted"
            }
          >
            File
          </TabButton>
          <TabButton
            active={view === "preview"}
            onClick={() => setView(worktreeId, "preview")}
            disabled={!selectedFile || !isMarkdownPath(selectedFile)}
          >
            Preview
          </TabButton>
          {selectedFile && (
            <span className="ml-2 min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-500">
              {selectedFile}
            </span>
          )}
          <LspProgressIndicator worktreeId={worktreeId} />
          <FocusToggle />
        </div>
        <div className="flex-1 overflow-auto">
          {!selectedFile ? (
            <div className="flex h-full items-center justify-center text-xs text-neutral-600">
              Select a file
            </div>
          ) : view === "file" ? (
            <EditorPane worktreeId={worktreeId} path={selectedFile} />
          ) : view === "preview" && isMarkdownPath(selectedFile) ? (
            <MarkdownPreview worktreeId={worktreeId} path={selectedFile} />
          ) : selected && diff ? (
            <DiffEditorView
              worktreeId={worktreeId}
              baseRef={diff.baseRef}
              file={selected}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-neutral-600">
              No diff for this file — switch to the File tab
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/// Shows the most-recent in-flight LSP progress for the current worktree,
/// aggregated across all enabled languages. Servers use `$/progress` to
/// announce indexing / cargo check / type-checking; without a cue the
/// editor feels broken for 10–60s on first open, especially with
/// rust-analyzer on a cold cache.
function LspProgressIndicator({ worktreeId }: { worktreeId: WorktreeId }) {
  const progress = useLspStore((s) => s.progress);
  const active = useMemo(() => {
    const prefix = `${worktreeId}::`;
    for (const [key, p] of Object.entries(progress)) {
      if (!key.startsWith(prefix) || !p) continue;
      return { languageId: key.slice(prefix.length), ...p };
    }
    return null;
  }, [progress, worktreeId]);

  if (!active) return null;

  const tail =
    typeof active.percentage === "number"
      ? `${Math.round(active.percentage)}%`
      : (active.message ?? "");

  return (
    <span
      className="ml-2 flex shrink-0 items-center gap-1 rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400"
      title={`${active.languageId}: ${active.title}${active.message ? " — " + active.message : ""}`}
    >
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
      <span className="max-w-[160px] truncate">
        {active.title}
        {tail ? ` · ${tail}` : ""}
      </span>
    </span>
  );
}

function FocusToggle() {
  const focusMode = useUiStore((s) => s.focusMode);
  const toggle = useUiStore((s) => s.toggleFocusMode);
  return (
    <button
      onClick={toggle}
      title={focusMode ? "Exit focus mode (⌘\\)" : "Focus mode (⌘\\)"}
      className={cn(
        "ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium",
        focusMode
          ? "bg-blue-900/50 text-blue-200 hover:bg-blue-900/70"
          : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200",
      )}
    >
      {focusMode ? "⤡" : "⤢"}
    </button>
  );
}

function TabButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded px-2 py-0.5 text-[11px] font-medium",
        active
          ? "bg-neutral-800 text-neutral-100"
          : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-neutral-400",
      )}
    >
      {children}
    </button>
  );
}

function StatusBadge({ status }: { status: FileStatus }) {
  const kind = status.kind;
  const map: Record<string, { label: string; cls: string }> = {
    added: { label: "A", cls: "bg-emerald-900/50 text-emerald-300" },
    modified: { label: "M", cls: "bg-amber-900/50 text-amber-300" },
    deleted: { label: "D", cls: "bg-rose-900/50 text-rose-300" },
    renamed: { label: "R", cls: "bg-blue-900/50 text-blue-300" },
    untracked: { label: "?", cls: "bg-neutral-800 text-neutral-400" },
  };
  const m = map[kind] ?? { label: "·", cls: "bg-neutral-800 text-neutral-400" };
  return (
    <span
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[11px] font-bold",
        m.cls,
      )}
    >
      {m.label}
    </span>
  );
}

/// Inline diff powered by Monaco's `DiffEditor` so we get syntax
/// highlighting, unified / side-by-side rendering, and folded-unchanged
/// regions. Fetches the "before" content via `git show <base_ref>:<path>`
/// and the "after" content from the worktree's workdir.
function DiffEditorView({
  worktreeId,
  baseRef,
  file,
}: {
  worktreeId: WorktreeId;
  baseRef: string;
  file: FileDiff;
}) {
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const language = useMemo(() => inferLanguage(file.path), [file.path]);

  useEffect(() => {
    if (file.binary) {
      setBefore("");
      setAfter("");
      return;
    }
    let cancelled = false;
    setError(null);
    setBefore(null);
    setAfter(null);

    const loadBefore = async (): Promise<string> => {
      // `deleted` / `modified`: the base-ref side holds the prior content.
      // `renamed`: the prior content lives at the old path (`from`).
      // `added` / `untracked`: no prior version — empty string.
      if (file.status.kind === "added" || file.status.kind === "untracked") {
        return "";
      }
      const oldPath =
        file.status.kind === "renamed" ? file.status.from : file.path;
      return await readBlobAtRef(worktreeId, oldPath, baseRef);
    };

    const loadAfter = async (): Promise<string> => {
      // Deleted files: no current workdir version.
      if (file.status.kind === "deleted") return "";
      const r = await readFile(worktreeId, file.path);
      return r.text ?? "";
    };

    (async () => {
      try {
        const [b, a] = await Promise.all([loadBefore(), loadAfter()]);
        if (cancelled) return;
        setBefore(b);
        setAfter(a);
      } catch (e: unknown) {
        if (cancelled) return;
        const msg =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
        setError(msg);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [worktreeId, baseRef, file.path, file.status, file.binary]);

  if (file.binary) {
    return (
      <div className="m-3 rounded border border-neutral-800 bg-neutral-900/60 p-4 text-center text-xs text-neutral-500">
        Binary file — no diff preview
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
  if (before === null || after === null) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-neutral-600">
        Loading diff…
      </div>
    );
  }
  return (
    <div className="h-full w-full bg-neutral-950">
      <DiffEditor
        original={before}
        modified={after}
        language={language}
        theme={THEME_NAME}
        beforeMount={defineTreehouseTheme}
        options={{
          readOnly: true,
          renderSideBySide: false,
          minimap: { enabled: false },
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 18,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          renderWhitespace: "none",
          renderLineHighlight: "none",
          // Collapse long runs of unchanged lines to the standard +/-3
          // context window — matches the mental model from `git diff`.
          hideUnchangedRegions: {
            enabled: true,
            contextLineCount: 3,
            minimumLineCount: 3,
            revealLineCount: 20,
          },
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
          },
          overviewRulerBorder: false,
          overviewRulerLanes: 0,
        }}
      />
    </div>
  );
}

