import { useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { useWorkspaceStore } from "@/stores/workspace";
import { useDiffsStore } from "@/stores/diffs";
import { BaseRefPicker } from "@/components/BaseRefPicker";
import { useLspStore } from "@/stores/lsp";
import { useNavigationStore } from "@/stores/navigation";
import { onDiffUpdated, readBlobAtRef, readFile } from "@/ipc/client";
import type { FileDiff, FileStatus, WorktreeId } from "@/ipc/types";
import { cn } from "@/lib/cn";
import { CommentOverlay, EditorPane } from "./EditorPane";
import { useEditorViewStateStore } from "@/stores/editor-view-state";
import { FileTree } from "./FileTree";
import { useIsEditorDirty } from "@/stores/editor-dirty";
import { MarkdownPreview, isMarkdownPath } from "./MarkdownPreview";
import { inferLanguage } from "./editor-language";
import { iconForFile, statusFilenameColor } from "./file-icons";
import { THEME_NAME } from "./monaco-theme";

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
  const workspaceId = useWorktreesStore(
    (s) => s.worktrees.find((w) => w.id === worktreeId)?.workspaceId,
  );
  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId),
  );
  const diff = useDiffsStore((s) => s.byWorktree[worktreeId]);
  const error = useDiffsStore((s) => s.error[worktreeId]);
  const selectedFile = useDiffsStore((s) => s.selectedFile[worktreeId] ?? null);
  const view = useDiffsStore((s) => s.view[worktreeId] ?? "file");
  const mode = useDiffsStore((s) => s.mode[worktreeId] ?? "branch");
  const fetchDiff = useDiffsStore((s) => s.fetch);
  const setDiff = useDiffsStore((s) => s.set);
  const selectFile = useDiffsStore((s) => s.selectFile);
  const setView = useDiffsStore((s) => s.setView);
  const setMode = useDiffsStore((s) => s.setMode);
  const [treeRefresh, setTreeRefresh] = useState(0);
  const showIgnored = useUiStore((s) => s.showIgnored);
  const setShowIgnored = useUiStore((s) => s.setShowIgnored);

  useEffect(() => {
    fetchDiff(worktreeId);
    const p = onDiffUpdated(worktreeId, (d) => {
      // The fs_watch payload is always branch-view; using it directly
      // when the user has flipped to uncommitted mode would
      // overwrite their view. Read the current mode at fire time and
      // either accept the payload or re-fetch.
      const mode =
        useDiffsStore.getState().mode[worktreeId] ?? "branch";
      if (mode === "branch") {
        setDiff(worktreeId, d);
      } else {
        void fetchDiff(worktreeId);
      }
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

  // Reconcile the active tab with what makes sense for the selected
  // file. Two directions:
  //
  // - File view + a binary or deleted file → fall through to Diff,
  //   since EditorPane would either render a "binary file" placeholder
  //   or fail to read a deleted path. This keeps File as the default
  //   landing tab without leaving the user staring at a useless pane.
  // - Diff view + a file that isn't in the diff (e.g. picked from the
  //   tree, not from the changed-files list) → fall back to File,
  //   since there's no diff to show. Preview is also a valid non-diff
  //   view; only force when the current tab is actually Diff so a
  //   freshly-selected Preview doesn't get clobbered.
  useEffect(() => {
    if (!selectedFile) return;
    const inDiff = diff?.files.some((f) => f.path === selectedFile) ?? false;
    const fileTabUnusable =
      (selected?.binary ?? false) || selected?.status.kind === "deleted";
    if (view === "file" && fileTabUnusable && inDiff) {
      setView(worktreeId, "diff");
    } else if (view === "diff" && !inDiff) {
      setView(worktreeId, "file");
    }
  }, [selectedFile, diff, selected, view, worktreeId, setView]);

  if (error) {
    return (
      <div className="m-3 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
        {error}
      </div>
    );
  }

  return (
    <PanelGroup
      direction="horizontal"
      className="flex h-full"
      autoSaveId="diff-sidebar"
    >
      <Panel defaultSize={22} minSize={12} maxSize={50}>
        <aside className="flex h-full flex-col border-r border-neutral-800">
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-900 px-3 py-2 text-[11px] uppercase tracking-wider text-neutral-500">
          <span>Changes ({diff?.stats.filesChanged ?? 0})</span>
          {diff && (
            <span className="font-mono text-[11px]">
              <span className="text-emerald-400">+{diff.stats.insertions}</span>{" "}
              <span className="text-rose-400">-{diff.stats.deletions}</span>
            </span>
          )}
        </div>
        {/* Diff anchor toggle. Branch = merge-base..workdir (default,
            full PR-style view). Uncommitted = HEAD..workdir, useful
            for reviewing the agent's most recent batch before
            committing. */}
        <div className="flex shrink-0 border-b border-neutral-900 p-1.5">
          <div className="flex w-full overflow-hidden rounded border border-neutral-800 text-[11px]">
            <button
              onClick={() => void setMode(worktreeId, "branch")}
              className={cn(
                "flex-1 px-2 py-1 transition",
                mode === "branch"
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-500 hover:bg-neutral-900",
              )}
              title="All changes since the branch forked from default"
            >
              Branch
            </button>
            <button
              onClick={() => void setMode(worktreeId, "uncommitted")}
              className={cn(
                "flex-1 border-l border-neutral-800 px-2 py-1 transition",
                mode === "uncommitted"
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-500 hover:bg-neutral-900",
              )}
              title="Just HEAD..workdir — the next commit's worth of changes"
            >
              Uncommitted
            </button>
          </div>
        </div>
        {workspace && mode === "branch" && (
          <div className="flex shrink-0 items-center overflow-visible border-b border-neutral-900 px-2 py-1 text-[11px]">
            <BaseRefPicker workspace={workspace} />
          </div>
        )}
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-neutral-900">
          {!diff || diff.files.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-neutral-600">
              {diff
                ? `No changes against ${diff.baseRef.slice(0, 8)}`
                : "Computing diff…"}
            </div>
          ) : (
            <ul>
              {diff.files.map((f) => {
                const basename = f.path.split("/").pop() ?? f.path;
                const { Icon, color } = iconForFile(basename);
                const isSelected = selectedFile === f.path;
                return (
                  <li key={f.path}>
                    <button
                      onClick={() => {
                        selectFile(worktreeId, f.path);
                        setView(worktreeId, "diff");
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-1 text-left text-xs transition-colors",
                        isSelected
                          ? "bg-[#3994BC26] text-neutral-100"
                          : "hover:bg-white/[0.04]",
                      )}
                      title={f.path}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Icon size={13} color={color} className="shrink-0" />
                        <span
                          className={cn(
                            "truncate font-mono text-[11px]",
                            statusFilenameColor(f.status.kind),
                          )}
                        >
                          {f.path}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px]">
                        <span className="text-emerald-400">+{f.insertions}</span>{" "}
                        <span className="text-rose-400">-{f.deletions}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-900 px-3 py-2 text-[11px] uppercase tracking-wider text-neutral-500">
          <span>Files</span>
          <button
            onClick={() => setShowIgnored(!showIgnored)}
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
      </Panel>
      <PanelResizeHandle className="w-px bg-neutral-800 hover:bg-neutral-700" />
      <Panel defaultSize={78}>
        <section className="flex h-full flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-950 px-2 py-1 text-[11px]">
          <NavButtons worktreeId={worktreeId} />
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
            active={view === "diff"}
            onClick={() => setView(worktreeId, "diff")}
            disabled={!selected}
          >
            Diff
          </TabButton>
          {selectedFile && isMarkdownPath(selectedFile) && (
            <TabButton
              active={view === "preview"}
              onClick={() => setView(worktreeId, "preview")}
            >
              Preview
            </TabButton>
          )}
          {selectedFile && (
            <FilePathLabel worktreeId={worktreeId} path={selectedFile} />
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
      </Panel>
    </PanelGroup>
  );
}

/// Path display in the editor tab strip, with a leading "● " when the
/// editor buffer has unsaved local edits. The dirty flag is published
/// to the editor-dirty store by EditorPane on every model change.
function FilePathLabel({
  worktreeId,
  path,
}: {
  worktreeId: WorktreeId;
  path: string;
}) {
  const dirty = useIsEditorDirty(worktreeId, path);
  return (
    <span className="ml-2 flex min-w-0 flex-1 items-center truncate font-mono text-[11px] text-neutral-500">
      {dirty && (
        <span
          className="mr-1 shrink-0 text-amber-400"
          title="Unsaved changes — Cmd+S to save"
        >
          ●
        </span>
      )}
      <span className="truncate">{path}</span>
    </span>
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

/// Browser-style back / forward through the per-worktree cursor-
/// position history, plus a dropdown trigger that lists every file
/// in the stack (deduped to the most-recent entry per file) for
/// click-to-jump. Selectors derive `canBack` / `canForward` from
/// `byWorktree` directly so the buttons re-render when the index
/// moves.
function NavButtons({ worktreeId }: { worktreeId: WorktreeId }) {
  const stack = useNavigationStore((s) => s.byWorktree[worktreeId]);
  const back = useNavigationStore((s) => s.back);
  const forward = useNavigationStore((s) => s.forward);
  const jumpTo = useNavigationStore((s) => s.jumpTo);
  const canBack = !!stack && stack.index > 0;
  const canForward = !!stack && stack.index < stack.entries.length - 1;
  const hasHistory = !!stack && stack.entries.length > 0;

  // Dedup by path, keeping the most-recent entry's index per file.
  // Walk newest → oldest so the first hit per path is the freshest.
  // The Map preserves insertion order, so iteration yields entries
  // in newest-first order — what the dropdown wants.
  const recentFiles = useMemo<{ path: string; index: number }[]>(() => {
    if (!stack) return [];
    const seen = new Map<string, number>();
    for (let i = stack.entries.length - 1; i >= 0; i--) {
      const e = stack.entries[i];
      if (!seen.has(e.path)) seen.set(e.path, i);
    }
    return Array.from(seen, ([path, index]) => ({ path, index }));
  }, [stack]);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative mr-1 flex items-center gap-0.5">
      <button
        onClick={() => back(worktreeId)}
        disabled={!canBack}
        title="Go back (⌘[)"
        aria-label="Go back"
        className={cn(
          "rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200",
          !canBack && "cursor-not-allowed opacity-30 hover:bg-transparent hover:text-neutral-400",
        )}
      >
        ←
      </button>
      <button
        onClick={() => forward(worktreeId)}
        disabled={!canForward}
        title="Go forward (⌘])"
        aria-label="Go forward"
        className={cn(
          "rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200",
          !canForward && "cursor-not-allowed opacity-30 hover:bg-transparent hover:text-neutral-400",
        )}
      >
        →
      </button>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={!hasHistory}
        title="File history"
        aria-label="File history"
        className={cn(
          "rounded px-1.5 py-0.5 text-[11px] leading-none text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200",
          open && "bg-neutral-800 text-neutral-100",
          !hasHistory && "cursor-not-allowed opacity-30 hover:bg-transparent hover:text-neutral-400",
        )}
      >
        ▼
      </button>
      {open && hasHistory && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-80 overflow-auto rounded-md border border-neutral-800 bg-neutral-900 shadow-2xl">
          {recentFiles.map(({ path, index }) => {
            const isCurrent = index === stack!.index;
            const entry = stack!.entries[index];
            const slash = path.lastIndexOf("/");
            const dir = slash >= 0 ? path.slice(0, slash) : "";
            const base = slash >= 0 ? path.slice(slash + 1) : path;
            return (
              <button
                key={`${path}:${index}`}
                onClick={() => {
                  jumpTo(worktreeId, index);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-neutral-800",
                  isCurrent
                    ? "border-l-2 border-blue-500 bg-blue-950/30 pl-1.5"
                    : "border-l-2 border-transparent",
                )}
                title={path}
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  <span className="text-neutral-100">{base}</span>
                  {dir && (
                    <span className="ml-1.5 text-neutral-500">{dir}</span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-neutral-500">
                  Ln {entry.line}, Col {entry.column}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
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
  const [modifiedEditor, setModifiedEditor] =
    useState<MonacoEditor.IStandaloneCodeEditor | null>(null);

  const language = useMemo(() => inferLanguage(file.path), [file.path]);

  const onMount: DiffOnMount = (diffEditor) => {
    // Anchor review comments to the modified (right-hand / new) side only —
    // suppressing the gutter "+" on the original side so users can't pin
    // comments to deleted lines they can't act on. Also hide the original
    // line-number column: in inline diff mode it renders inside the
    // modified gutter and would push the review "+" to the right of the
    // line number, inverting the order vs the File view.
    diffEditor.getOriginalEditor().updateOptions({
      glyphMargin: false,
      lineNumbers: "off",
    });
    setModifiedEditor(diffEditor.getModifiedEditor());
  };

  // Restore Monaco view state on the modified-side editor for a
  // worktree round-trip; save back on key change / unmount. Keyed
  // separately from the file-view editor (different content shape)
  // so the diff doesn't try to scroll to the file's line offset.
  useEffect(() => {
    if (!modifiedEditor) return;
    const saved = useEditorViewStateStore
      .getState()
      .get(worktreeId, file.path, "diff");
    if (saved) modifiedEditor.restoreViewState(saved);
    return () => {
      const state = modifiedEditor.saveViewState();
      useEditorViewStateStore
        .getState()
        .save(worktreeId, file.path, "diff", state);
    };
  }, [modifiedEditor, worktreeId, file.path]);

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
    <div className="relative h-full w-full bg-neutral-950">
      <DiffEditor
        original={before}
        modified={after}
        language={language}
        theme={THEME_NAME}
        onMount={onMount}
        options={{
          readOnly: true,
          // The default `renderValidationDecorations: "editable"` hides
          // squiggles in read-only mode. We want LSP markers (clangd /
          // rust-analyzer) visible in the diff so review surfaces what
          // the language server thinks of the new side.
          renderValidationDecorations: "on",
          renderSideBySide: false,
          minimap: { enabled: false },
          glyphMargin: true,
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
      {modifiedEditor && (
        <CommentOverlay
          editor={modifiedEditor}
          worktreeId={worktreeId}
          filePath={file.path}
        />
      )}
    </div>
  );
}

