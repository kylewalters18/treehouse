import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  MessageSquarePlus,
} from "lucide-react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { useWorkspaceStore } from "@/stores/workspace";
import { useDiffsStore, type ChangeGroup } from "@/stores/diffs";
import { BaseRefPicker } from "@/components/BaseRefPicker";
import { MrBar } from "@/components/MrBar";
import { useLspStore } from "@/stores/lsp";
import { useNavigationStore } from "@/stores/navigation";
import { onDiffUpdated, readBlobAtRef, readFile } from "@/ipc/client";
import type {
  DiffSet,
  FileDiff,
  FileStatus,
  Workspace,
  WorktreeId,
} from "@/ipc/types";
import { cn } from "@/lib/cn";
import { effectiveBaseRef } from "@/lib/base-ref";
import { countBadge, iconButton, sectionStrip, sectionTab } from "@/lib/pane-chrome";
import { CommentOverlay, EditorPane } from "./EditorPane";
import { useEditorViewStateStore } from "@/stores/editor-view-state";
import { FileTree } from "./FileTree";
import { useIsEditorDirty } from "@/stores/editor-dirty";
import { MarkdownPreview, isMarkdownPath } from "./MarkdownPreview";
import { inferLanguage } from "./editor-language";
import { explorerRow, iconForFile, statusFilenameColor } from "./file-icons";
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
  const branch = useWorktreesStore(
    (s) => s.worktrees.find((w) => w.id === worktreeId)?.branch ?? null,
  );
  const diff = useDiffsStore((s) => s.byWorktree[worktreeId]);
  const uncommitted = useDiffsStore(
    (s) => s.uncommittedByWorktree[worktreeId],
  );
  const error = useDiffsStore((s) => s.error[worktreeId]);
  const selectedFile = useDiffsStore((s) => s.selectedFile[worktreeId] ?? null);
  const selectedGroup = useDiffsStore(
    (s) => s.selectedGroup[worktreeId] ?? "branch",
  );
  const view = useDiffsStore((s) => s.view[worktreeId] ?? "file");
  const fetchDiff = useDiffsStore((s) => s.fetch);
  const fetchUncommitted = useDiffsStore((s) => s.fetchUncommitted);
  const setDiff = useDiffsStore((s) => s.set);
  const selectFile = useDiffsStore((s) => s.selectFile);
  const setView = useDiffsStore((s) => s.setView);
  const [treeRefresh, setTreeRefresh] = useState(0);
  const showIgnored = useUiStore((s) => s.showIgnored);
  const setShowIgnored = useUiStore((s) => s.setShowIgnored);
  const sidebarTab = useUiStore((s) => s.diffSidebarTab);
  const setSidebarTab = useUiStore((s) => s.setDiffSidebarTab);

  useEffect(() => {
    fetchDiff(worktreeId);
    const p = onDiffUpdated(worktreeId, (d) => {
      // The fs_watch payload is the branch diff; the uncommitted group
      // isn't pushed, so refetch it alongside (cheap — HEAD..workdir).
      setDiff(worktreeId, d);
      void fetchUncommitted(worktreeId).catch(() => {});
      setTreeRefresh((n) => n + 1);
    });
    return () => {
      p.then((fn) => fn()).catch(() => {});
    };
  }, [worktreeId, fetchDiff, fetchUncommitted, setDiff]);

  const statusByPath = useMemo<Map<string, FileStatus>>(() => {
    const m = new Map<string, FileStatus>();
    for (const f of uncommitted?.files ?? []) m.set(f.path, f.status);
    // Branch status wins: it's relative to what merge-back ships.
    for (const f of diff?.files ?? []) m.set(f.path, f.status);
    return m;
  }, [diff, uncommitted]);

  // Resolve the selected file against the group it was picked from,
  // falling back to the other group (e.g. picked from the tree, or the
  // file just got committed and left the Uncommitted group).
  const resolved = useMemo<{
    file: FileDiff;
    set: DiffSet;
    group: ChangeGroup;
  } | null>(() => {
    if (!selectedFile) return null;
    const order: [ChangeGroup, DiffSet | undefined][] =
      selectedGroup === "uncommitted"
        ? [["uncommitted", uncommitted], ["branch", diff]]
        : [["branch", diff], ["uncommitted", uncommitted]];
    for (const [group, set] of order) {
      const file = set?.files.find((f) => f.path === selectedFile);
      if (set && file) return { file, set, group };
    }
    return null;
  }, [diff, uncommitted, selectedFile, selectedGroup]);
  const selected = resolved?.file ?? null;

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
  //
  // Never bounce File → Diff while the open buffer is dirty: that
  // unmounts the editor and silently drops the user's unsaved edits.
  // The editor's own "deleted on disk" banner owns that case.
  const selectedDirty = useIsEditorDirty(worktreeId, selectedFile);
  useEffect(() => {
    if (!selectedFile) return;
    const inDiff = selected != null;
    const fileTabUnusable =
      (selected?.binary ?? false) || selected?.status.kind === "deleted";
    if (view === "file" && fileTabUnusable && inDiff && !selectedDirty) {
      setView(worktreeId, "diff");
    } else if (view === "diff" && !inDiff) {
      setView(worktreeId, "file");
    }
  }, [selectedFile, selected, view, worktreeId, setView, selectedDirty]);

  if (error) {
    return (
      <div className="m-3 rounded-md border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-300">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {workspace && branch && (
        <MrBar workspaceId={workspace.id} worktreeId={worktreeId} branch={branch} />
      )}
    <PanelGroup
      direction="horizontal"
      className="flex min-h-0 flex-1"
      autoSaveId="diff-sidebar"
    >
      <Panel defaultSize={22} minSize={12} maxSize={50}>
        <aside className="flex h-full flex-col border-r border-neutral-800">
        {/* Changes / Files toggle — one list at a time so each gets
            the full sidebar height. */}
        <div className={cn(sectionStrip, "justify-between gap-2")}>
          <div className="flex items-stretch gap-3">
            <SidebarTab
              active={sidebarTab === "files"}
              onClick={() => setSidebarTab("files")}
            >
              Files
            </SidebarTab>
            <SidebarTab
              active={sidebarTab === "changes"}
              onClick={() => setSidebarTab("changes")}
            >
              Changes
              <span className={countBadge("neutral")}>
                {diff?.stats.filesChanged ?? 0}
              </span>
            </SidebarTab>
          </div>
          {sidebarTab === "changes"
            ? diff && (
                <span className="self-center font-mono text-[11px]">
                  <span className="text-emerald-400">+{diff.stats.insertions}</span>{" "}
                  <span className="text-rose-400">-{diff.stats.deletions}</span>
                </span>
              )
            : (
                <button
                  onClick={() => setShowIgnored(!showIgnored)}
                  title={
                    showIgnored
                      ? "Hide gitignored files"
                      : "Show gitignored files (dimmed)"
                  }
                  className={cn(
                    "self-center rounded px-1 font-mono text-[10px] transition",
                    showIgnored
                      ? "bg-neutral-800 text-neutral-200"
                      : "text-neutral-600 hover:bg-neutral-900 hover:text-neutral-300",
                  )}
                >
                  {showIgnored ? "◉ ignored" : "○ ignored"}
                </button>
              )}
        </div>
        {sidebarTab === "changes" && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ChangeGroupSection
              group="uncommitted"
              label="Uncommitted"
              diff={uncommitted}
              anchor={<span className="text-neutral-600">vs HEAD</span>}
              selectedFile={resolved?.group === "uncommitted" ? selectedFile : null}
              onSelect={(path) => {
                selectFile(worktreeId, path, "uncommitted");
                setView(worktreeId, "diff");
              }}
            />
            <ChangeGroupSection
              group="branch"
              label="Branch"
              diff={diff}
              anchor={workspace && <BaseRefPicker workspace={workspace} />}
              selectedFile={resolved?.group === "branch" ? selectedFile : null}
              onSelect={(path) => {
                selectFile(worktreeId, path, "branch");
                setView(worktreeId, "diff");
              }}
            />
          </div>
        )}
        {/* Kept mounted while hidden so the tree's expansion state
            survives flipping to Changes and back. */}
        <div className={cn("min-h-0 flex-1 overflow-y-auto", sidebarTab !== "files" && "hidden")}>
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
        <div className="flex h-[34px] shrink-0 items-center gap-1.5 border-b border-neutral-800 bg-chrome px-2 text-[11px]">
          <NavButtons worktreeId={worktreeId} />
          <div className="flex shrink-0 gap-0.5 rounded-md border border-neutral-800 bg-neutral-950 p-0.5">
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
          </div>
          {selectedFile && (
            <FilePathLabel
              worktreeId={worktreeId}
              path={selectedFile}
              anchor={
                view === "diff" && resolved
                  ? resolved.group === "uncommitted"
                    ? "HEAD"
                    : baseRefLabel(workspace)
                  : null
              }
            />
          )}
          {selectedFile && view !== "preview" && (
            <ReviewControls worktreeId={worktreeId} path={selectedFile} />
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
          ) : resolved ? (
            <DiffEditorView
              worktreeId={worktreeId}
              baseRef={resolved.set.baseRef}
              file={resolved.file}
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
    </div>
  );
}

/// Path display in the editor tab strip, with a leading "● " when the
/// editor buffer has unsaved local edits. The dirty flag is published
/// to the editor-dirty store by EditorPane on every model change.
function FilePathLabel({
  worktreeId,
  path,
  anchor,
}: {
  worktreeId: WorktreeId;
  path: string;
  /// Ref the Diff tab compares against, shown as "· vs <anchor>".
  anchor: string | null;
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
      {anchor && (
        <span className="ml-1.5 shrink-0 text-neutral-600">· vs {anchor}</span>
      )}
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

function baseRefLabel(workspace: Workspace | undefined): string {
  return workspace ? effectiveBaseRef(workspace) : "base";
}

/// One collapsible group in the Changes tab: a header with the count
/// and what it compares against, then the changed-file rows.
function ChangeGroupSection({
  group,
  label,
  diff,
  anchor,
  selectedFile,
  onSelect,
}: {
  group: ChangeGroup;
  label: string;
  diff: DiffSet | undefined;
  anchor: React.ReactNode;
  selectedFile: string | null;
  onSelect: (path: string) => void;
}) {
  const collapsed = useUiStore((s) => s.collapsedChangeGroups[group]);
  const toggle = useUiStore((s) => s.toggleChangeGroup);
  const files = diff?.files ?? [];
  const empty = diff != null && files.length === 0;
  const open = !collapsed && !empty;

  return (
    <section className="border-b border-neutral-800/60">
      <div className="flex h-7 items-center justify-between gap-2 pl-2 pr-2 text-[11px]">
        <button
          onClick={() => toggle(group)}
          disabled={empty}
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] transition-colors",
            empty
              ? "cursor-default text-neutral-600"
              : "text-neutral-400 hover:text-neutral-200",
          )}
        >
          <span className="flex w-3 justify-center text-neutral-600">
            {open ? (
              <ChevronDown size={12} strokeWidth={2} />
            ) : (
              <ChevronRight size={12} strokeWidth={2} />
            )}
          </span>
          <span>{label}</span>
          {diff == null || empty ? (
            <span className="normal-case tracking-normal text-neutral-600">
              {diff == null ? "…" : "clean"}
            </span>
          ) : (
            <span className={countBadge("neutral")}>{files.length}</span>
          )}
        </button>
        <div className="flex min-w-0 items-center">{anchor}</div>
      </div>
      {open && (
        <ul className="pb-1">
          {files.map((f) => {
            const basename = f.path.split("/").pop() ?? f.path;
            const { Icon, color } = iconForFile(basename);
            const isSelected = selectedFile === f.path;
            return (
              <li key={f.path}>
                <button
                  onClick={() => onSelect(f.path)}
                  className={cn(
                    "relative flex h-[22px] w-full items-center justify-between gap-2 pl-[26px] pr-2 text-left text-[12px] transition-colors",
                    explorerRow(isSelected),
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
                  <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
                    <span className="text-emerald-400">+{f.insertions}</span>{" "}
                    <span className="text-rose-400">-{f.deletions}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/// Header controls for inline review comments on the open file. They live
/// in the pane chrome rather than floating over the editor so they never
/// cover code.
function ReviewControls({
  worktreeId,
  path,
}: {
  worktreeId: WorktreeId;
  path: string;
}) {
  const showResolved = useUiStore((s) => s.showResolvedComments);
  const toggleShowResolved = useUiStore((s) => s.toggleShowResolvedComments);
  const requestFileComment = useUiStore((s) => s.requestFileComment);
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        onClick={() => requestFileComment(worktreeId, path)}
        title="Comment on this whole file"
        aria-label="Comment on file"
        className={iconButton}
      >
        <MessageSquarePlus size={14} />
      </button>
      <button
        onClick={toggleShowResolved}
        title={showResolved ? "Hide resolved comments" : "Show resolved comments"}
        aria-label={showResolved ? "Hide resolved" : "Show resolved"}
        aria-pressed={showResolved}
        className={cn(iconButton, showResolved && "bg-neutral-800 text-neutral-100")}
      >
        {showResolved ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

function SidebarTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={sectionTab(active)}
    >
      {children}
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
        "rounded px-2 py-px text-[11px] font-medium",
        active
          ? "bg-neutral-800 text-neutral-100"
          : "text-neutral-500 hover:text-neutral-200",
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
  const [diffEditor, setDiffEditor] =
    useState<MonacoEditor.IStandaloneDiffEditor | null>(null);

  const language = useMemo(() => inferLanguage(file.path), [file.path]);

  const onMount: DiffOnMount = (diffEditor) => {
    // Review comments live on the modified editor. The original editor
    // gets no glyph "+" of its own; removed lines are commented on through
    // the hover "+" CommentOverlay draws over Monaco's deleted-code zones.
    // Also hide the original line-number column: in inline diff mode it
    // renders inside the modified gutter and would push the review "+" to
    // the right of the line number, inverting the order vs the File view.
    diffEditor.getOriginalEditor().updateOptions({
      glyphMargin: false,
      lineNumbers: "off",
    });
    setModifiedEditor(diffEditor.getModifiedEditor());
    setDiffEditor(diffEditor);
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
      <div className="m-3 rounded-md border border-neutral-800 bg-neutral-900 p-4 text-center text-xs text-neutral-500">
        Binary file — no diff preview
      </div>
    );
  }
  if (error) {
    return (
      <div className="m-3 rounded-md border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-300">
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
          diffEditor={diffEditor ?? undefined}
        />
      )}
    </div>
  );
}

