import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  GitPullRequest,
  MessageSquare,
  X,
} from "lucide-react";
import Editor, { type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { editor as MonacoEditor } from "monaco-editor";
import { THEME_NAME } from "./monaco-theme";
import {
  listAgentsForWorktree,
  onDiffUpdated,
  readFile,
  writeFile,
} from "@/ipc/client";
import { useEditorDirtyStore } from "@/stores/editor-dirty";
import { pasteAndSubmit } from "@/lib/agent";
import type {
  AgentSession,
  AgentSessionId,
  Comment,
  CommentSide,
  FileContent,
  ForgeThread,
  WorktreeId,
} from "@/ipc/types";
import {
  anchorLabel,
  commentStatus,
  formatCommentForAgent,
  reviewKey,
  useCommentsStore,
  type CommentStatus,
} from "@/stores/comments";
import { useForgeStore, forgeBranchKey, useForgeTerms } from "@/stores/forge";
import { postCommentsToMr } from "@/lib/review-post";
import { useLspStore } from "@/stores/lsp";
import { useNavigationStore } from "@/stores/navigation";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { workspaceForWorktree } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import { asMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";
import { countBadge } from "@/lib/pane-chrome";
import { findConfigForLanguage } from "@/lsp/languages";
import {
  LspNotFoundError,
  closeInSession,
  ensureSession,
  openInSession,
  resolveDefinition,
} from "@/lsp/manager";
import { useDiffsStore } from "@/stores/diffs";
import { useEditorViewStateStore } from "@/stores/editor-view-state";
import { inferLanguage } from "./editor-language";
import {
  baseLineMapper,
  rangeFromSelection,
  targetLabel,
  type CommentTarget,
} from "./review-anchors";
import {
  SUSPECT_RECHECK_MS,
  classifyDiskRead,
  computeLineEdits,
  createCoalescedRunner,
  type DiskRead,
} from "./disk-sync";

export { inferLanguage };

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
    (async () => {
      try {
        const c = await readFile(worktreeId, path);
        if (!cancelled) {
          setContent(c);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(asMessage(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // EditorPane only does the initial read; EditorWithComments owns the
    // diff_updated listener so the conflict policy has access to the
    // live Monaco model (and we don't reset the model out from under
    // the user via a parent setState).
  }, [worktreeId, path]);

  const language = useMemo(() => (path ? inferLanguage(path) : "plaintext"), [path]);

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 text-xs text-neutral-500">
        Pick a file on the left to view its contents
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 text-xs text-neutral-500">
        Loading…
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
  if (!content) return null;

  if (content.binary) {
    return (
      <div className="m-3 rounded-md border border-neutral-800 bg-neutral-900 p-4 text-center text-xs text-neutral-500">
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
    <div className="relative h-full w-full bg-neutral-950">
      {/* `key={path}` so a file switch tears the whole subtree down:
          fresh Monaco model, fresh dirty/conflict refs, no carryover
          from the previous file. */}
      <EditorWithComments
        key={path}
        worktreeId={worktreeId}
        path={path}
        initialContent={content.text}
        language={language}
      />
    </div>
  );
}

// --- Inline review comments (view zone spacer + overlay widget) ---

function EditorWithComments({
  worktreeId,
  path,
  initialContent,
  language,
}: {
  worktreeId: WorktreeId;
  path: string;
  initialContent: string;
  language: string;
}) {
  const [editor, setEditor] = useState<MonacoEditor.IStandaloneCodeEditor | null>(
    null,
  );
  const [cursorPos, setCursorPos] = useState<{
    line: number;
    column: number;
  } | null>(null);
  // The string we last successfully loaded from / wrote to disk. Compared
  // against the live Monaco model to drive both the dirty indicator and
  // the conflict policy: a diff_updated event whose disk content equals
  // this string is an echo of our own write, and a dirty buffer (model !=
  // this) blocks silent reload from disk.
  const lastReadContentRef = useRef(initialContent);
  // Non-null iff the conflict banner is showing. `changed` carries the
  // new disk content (so "Reload" can apply it); `deleted` means the
  // path is gone on disk.
  type PendingDisk =
    | { kind: "changed"; content: string }
    | { kind: "deleted" };
  const [pendingDisk, setPendingDisk] = useState<PendingDisk | null>(null);
  const setDirtyStore = useEditorDirtyStore((s) => s.set);
  const onMount: OnMount = (e) => {
    setEditor(e);
    const pos = e.getPosition();
    if (pos) setCursorPos({ line: pos.lineNumber, column: pos.column });
  };

  useLspIntegration(editor, worktreeId, path, language);
  useGotoClickHandler(editor, worktreeId, language);
  usePendingReveal(editor, worktreeId, path, initialContent);

  /// Save the current model content to disk via the write_file IPC. On
  /// success, refresh `lastReadContent` to the just-saved value so the
  /// subsequent diff_updated echo lines up and we don't false-positive
  /// the conflict banner. Implicit "Keep editing" if a banner is up.
  const save = async () => {
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const value = model.getValue();
    try {
      await writeFile(worktreeId, path, value);
      lastReadContentRef.current = value;
      setDirtyStore(worktreeId, path, false);
      setPendingDisk(null);
    } catch (e) {
      toastError("Save failed", asMessage(e));
    }
  };
  // Latest-save ref so the Cmd+S command (registered once per editor
  // mount) always invokes the *current* save closure rather than the
  // stale one from the registration moment.
  const saveRef = useRef(save);
  saveRef.current = save;

  // Bind Cmd+S to save. `addCommand` registers a Monaco-internal command
  // (no `addAction` UI in the command palette), which is what we want —
  // save is a system thing, not a discoverable editor action.
  useEffect(() => {
    if (!editor) return;
    const disposable = editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        void saveRef.current();
      },
    );
    // `addCommand` returns a disposable id since monaco 0.20-ish; older
    // versions return null. Wrap defensively.
    return () => {
      if (disposable && typeof disposable === "object" && "dispose" in disposable) {
        (disposable as { dispose: () => void }).dispose();
      }
    };
  }, [editor]);

  // Track dirty state by subscribing to model edits. Compare against
  // `lastReadContentRef` so a paste that arrives at the same content
  // (e.g. "undo all my edits") correctly flips back to clean.
  useEffect(() => {
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const sub = model.onDidChangeContent(() => {
      const isDirty = model.getValue() !== lastReadContentRef.current;
      setDirtyStore(worktreeId, path, isDirty);
    });
    return () => sub.dispose();
  }, [editor, worktreeId, path, setDirtyStore]);

  // Clear the dirty flag in the store on unmount so the file path
  // label doesn't show a stale dot after the editor is gone (e.g. when
  // the user closes the file or switches worktrees).
  useEffect(() => {
    return () => {
      setDirtyStore(worktreeId, path, false);
    };
  }, [worktreeId, path, setDirtyStore]);

  // Conflict-aware reload-on-disk. When fs_watch emits diff_updated for
  // our path, re-fetch the file and decide (see `classifyDiskRead`):
  //   - disk == lastRead  → echo of our own write, no-op
  //   - clean buffer, disk changed → silently apply to model + refresh
  //     lastRead
  //   - dirty buffer, disk changed → show banner; stash the new content
  //   - read error / sudden empty → re-check once after a beat before
  //     believing it (agents truncate-then-write), then "deleted"
  //
  // Reads go through a coalesced runner: one in flight, one pending,
  // and a run superseded by a newer event drops its result. Without it
  // a burst of events during a streaming agent write fans out into
  // concurrent reads that resolve out of order and apply stale content
  // over newer content.
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const runner = createCoalescedRunner(async (isStale) => {
      let confirmed = false;
      for (;;) {
        const read: DiskRead = await readFile(worktreeId, path).then(
          (c) => ({ ok: true, text: c.text }),
          () => ({ ok: false }),
        );
        if (isStale()) return;
        const verdict = classifyDiskRead(read, lastReadContentRef.current, confirmed);
        if (verdict.kind === "suspect") {
          await new Promise((r) => setTimeout(r, SUSPECT_RECHECK_MS));
          if (isStale()) return;
          confirmed = true;
          continue;
        }
        if (verdict.kind === "ignore" || verdict.kind === "echo") return;
        const next: PendingDisk = verdict;
        const model = editor.getModel();
        if (!model) return;
        const isDirty = model.getValue() !== lastReadContentRef.current;
        if (!isDirty) {
          const newText = next.kind === "changed" ? next.content : "";
          // Update lastRead *before* the edit so the onDidChangeContent
          // dirty tracker sees model == lastRead and never flips the
          // tab's dirty dot on for an agent write.
          lastReadContentRef.current = newText;
          applyDiskText(model, newText);
          setDirtyStore(worktreeId, path, false);
          return;
        }
        // Dirty → surface conflict (or update the stashed disk content
        // if the banner is already up from an earlier event).
        setPendingDisk(next);
        return;
      }
    });
    // The payload lists files that differ from base, so an agent write
    // that reverts our file to base drops it from the list. Keep
    // reacting for one event after it leaves so that revert still
    // lands. Starts true: the first event always re-checks.
    let wasInDiff = true;
    onDiffUpdated(worktreeId, (diff) => {
      if (cancelled) return;
      const inDiff = diff.files.some((f) => f.path === path);
      const relevant = inDiff || wasInDiff;
      wasInDiff = inDiff;
      if (relevant) runner.trigger();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      runner.dispose();
      unlisten?.();
    };
  }, [editor, worktreeId, path, setDirtyStore]);

  /// "Reload from disk" / "Discard local edits" — hard discard. Replace
  /// the model with the new disk content (empty string for the delete
  /// case) and treat that as the new lastRead.
  const reloadFromDisk = () => {
    if (!editor || !pendingDisk) return;
    const model = editor.getModel();
    if (!model) return;
    const newValue = pendingDisk.kind === "changed" ? pendingDisk.content : "";
    lastReadContentRef.current = newValue;
    applyDiskText(model, newValue);
    setDirtyStore(worktreeId, path, false);
    setPendingDisk(null);
  };

  // Mirror Monaco's cursor position into local state so the bottom-right
  // indicator updates as the user navigates. Monaco fires this for both
  // keyboard motion and click positioning, so one subscription covers all
  // sources. Same handler feeds the back/forward navigation history —
  // small moves update the current entry in place; big jumps push.
  const recordNav = useNavigationStore((s) => s.record);
  useEffect(() => {
    if (!editor) return;
    // Seed history with the file's initial cursor position so the very
    // first cross-file jump has somewhere to go back *to*.
    const initial = editor.getPosition();
    if (initial) {
      recordNav(worktreeId, path, initial.lineNumber, initial.column);
    }
    const sub = editor.onDidChangeCursorPosition((e) => {
      setCursorPos({ line: e.position.lineNumber, column: e.position.column });
      recordNav(worktreeId, path, e.position.lineNumber, e.position.column);
    });
    return () => sub.dispose();
  }, [editor, worktreeId, path, recordNav]);

  // Restore Monaco view state (scroll + cursor + selections + folds)
  // when the (worktreeId, path) key first becomes mountable, save it
  // back when that key changes or the editor unmounts. Worktree
  // round-trips and worktree-internal file switches both go through
  // this — the user lands where they were instead of at the top of
  // the file.
  //
  // `pendingReveal` (cross-file LSP goto) takes precedence: when set
  // it positions the cursor + scrolls explicitly, so we skip the
  // restore in that case to avoid fighting it.
  useEffect(() => {
    if (!editor) return;
    const pending = useDiffsStore.getState().pendingReveal[worktreeId];
    const targetingThisFile = pending && pending.path === path;
    if (!targetingThisFile) {
      const saved = useEditorViewStateStore
        .getState()
        .get(worktreeId, path, "file");
      if (saved) editor.restoreViewState(saved);
    }
    return () => {
      const state = editor.saveViewState();
      useEditorViewStateStore
        .getState()
        .save(worktreeId, path, "file", state);
    };
  }, [editor, worktreeId, path]);

  return (
    <div className="flex h-full w-full flex-col">
      {pendingDisk && (
        <ConflictBanner
          kind={pendingDisk.kind}
          onReload={reloadFromDisk}
          onDismiss={() => setPendingDisk(null)}
        />
      )}
      <div className="relative flex-1">
      <Editor
        // `defaultValue` (not `value`) so the prop never clobbers the
        // model after the user starts typing — local edits survive
        // ancestor re-renders. Cross-file switches are handled by the
        // parent's `key={path}` on this whole component, which tears
        // the editor down and remounts with a fresh `defaultValue`.
        height="100%"
        language={language}
        defaultValue={initialContent}
        theme={THEME_NAME}
        onMount={onMount}
        path={path}
        options={{
          // Editable (not `readOnly: true`) for two reasons: Monaco
          // gates the code-action oracle on editability
          // (codeActionModel.js:173), so the clang-tidy lightbulb /
          // Cmd+. menu only appears when the editor is editable; AND
          // we now support write-back (Cmd+S writes the buffer to
          // disk via the `write_file` IPC).
          minimap: { enabled: false },
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 18,
          glyphMargin: true,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          renderWhitespace: "none",
          renderLineHighlight: "line",
          tabSize: 2,
          padding: { top: 8, bottom: 8 },
          cursorBlinking: "smooth",
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
            useShadows: false,
          },
          overviewRulerBorder: false,
          overviewRulerLanes: 0,
          guides: {
            indentation: true,
            highlightActiveIndentation: false,
          },
        }}
      />
      {editor && (
        <CommentOverlay
          editor={editor}
          worktreeId={worktreeId}
          filePath={path}
        />
      )}
      {cursorPos && (
        <div
          className="pointer-events-none absolute bottom-1.5 right-4 z-20 rounded-md border border-neutral-800 bg-chrome/90 px-1.5 py-px font-mono text-[10px] tabular-nums text-neutral-500"
          aria-label="Cursor position"
        >
          Ln {cursorPos.line}, Col {cursorPos.column}
        </div>
      )}
      </div>
    </div>
  );
}

/// Bring `model` to `newText` with one edit per changed hunk, instead
/// of `model.setValue(newText)`. setValue is a full-buffer replace —
/// every call wipes scroll position, cursor, selection, folds, and
/// forces full re-tokenization. That's catastrophic when an agent is
/// writing the open file at debounce cadence (~150ms).
///
/// Per-hunk rather than a single prefix/suffix span: Monaco keeps the
/// viewport stable across edits by tracking the top visible line, but
/// an edit whose range *covers* that line collapses the anchor to the
/// edit start. A single span from the first change to the last (say
/// lines 10 and 500) covers everything between, so a reader at line
/// 200 got yanked to line 10 on every agent write. With per-hunk edits
/// only lines that actually changed move; cursor and viewport outside
/// them stay put.
///
/// Wrapped in undo stops so an agent write is its own undo step and
/// never merges into the user's in-progress typing group.
function applyDiskText(
  model: MonacoEditor.ITextModel,
  newText: string,
): void {
  const edits = computeLineEdits(model.getValue(), newText);
  if (edits.length === 0) return;
  model.pushStackElement();
  model.pushEditOperations(
    [],
    edits.map((e) => {
      const start = model.getPositionAt(e.start);
      const end = model.getPositionAt(e.end);
      return {
        range: new monaco.Range(
          start.lineNumber,
          start.column,
          end.lineNumber,
          end.column,
        ),
        text: e.text,
      };
    }),
    () => null,
  );
  model.pushStackElement();
}

/// Sticky banner above the editor surfacing the conflict policy: the
/// file on disk diverged from the user's last-loaded state while they
/// had unsaved local edits. "Reload from disk" hard-discards the local
/// buffer; "Keep editing" dismisses — the next save then overwrites the
/// agent's intervening writes (or recreates a deleted file).
function ConflictBanner({
  kind,
  onReload,
  onDismiss,
}: {
  kind: "changed" | "deleted";
  onReload: () => void;
  onDismiss: () => void;
}) {
  const title =
    kind === "changed"
      ? "Modified on disk while you were editing."
      : "Deleted on disk while you were editing.";
  const reloadLabel = kind === "changed" ? "Reload from disk" : "Discard local edits";
  const keepLabel =
    kind === "changed"
      ? "Keep editing"
      : "Keep editing — next save recreates the file";
  return (
    <div className="flex h-[34px] shrink-0 items-center justify-between gap-3 border-b border-amber-400/20 bg-amber-400/[0.06] px-3 text-xs text-amber-200">
      <span className="flex min-w-0 items-center gap-2">
        <AlertTriangle size={13} className="shrink-0 text-amber-400" />
        <span className="truncate">{title}</span>
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={onReload}
          className="flex h-6 items-center rounded-md bg-amber-400/15 px-2 text-[11px] font-medium text-amber-100 transition-colors hover:bg-amber-400/25"
        >
          {reloadLabel}
        </button>
        <button
          onClick={onDismiss}
          className="flex h-6 items-center rounded-md px-2 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
        >
          {keepLabel}
        </button>
      </div>
    </div>
  );
}

/// Every zone sits in the editor after model line `after` (0 = top of the
/// file). `ordinal` breaks ties with Monaco's own zones on the same line —
/// removed-line comments use a high one so they render below the deleted
/// block they refer to.
type ZoneDesc =
  | { key: string; kind: "widget"; after: number; ordinal?: number; heightLines: number; comment: Comment }
  | { key: string; kind: "composer"; after: number; ordinal?: number; heightLines: number; target: CommentTarget }
  | { key: string; kind: "thread"; after: number; ordinal?: number; heightLines: number; thread: ForgeThread };

/// Tie-break for zones anchored to removed (base-side) lines; Monaco's
/// deleted-code zones use the default 10000.
const BASE_SIDE_ORDINAL = 20000;

type ZoneEntry = {
  desc: ZoneDesc;
  viewZoneId: string;
  widget: MonacoEditor.IOverlayWidget;
  domNode: HTMLDivElement;
  /// The live IViewZone object Monaco holds — we mutate `heightInPx` and
  /// `layoutZone(id)` to grow a thread zone to its measured content height.
  zone: MonacoEditor.IViewZone;
};

const WIDGET_HEIGHT_LINES = 5;
const COMPOSER_HEIGHT_LINES = 8;
const THREAD_HEIGHT_LINES = 7;

/// Renders review comments inline using the ZoneWidget pattern VSCode uses
/// internally: a Monaco view zone reserves vertical space (pushing code down)
/// while an `IOverlayWidget` carries the interactive DOM. Overlay widgets
/// render in Monaco's overlay layer, where input events don't hit the
/// read-only editor's keybinding dispatcher — so the composer textarea works
/// without the "Cannot edit in read-only editor" toast firing.
///
/// Each comment (and the transient composer) is a pair: view zone + overlay
/// widget, kept in sync via the view zone's `onDomNodeTop`/`onComputedHeight`
/// callbacks. Widget content is rendered with React `createPortal` into the
/// overlay's DOM node.
export function CommentOverlay({
  editor,
  worktreeId,
  filePath,
  diffEditor,
}: {
  editor: MonacoEditor.IStandaloneCodeEditor;
  worktreeId: WorktreeId;
  filePath: string;
  /// Set when `editor` is the modified side of an inline diff. Enables
  /// comments on removed lines: they render under the deleted-code block and
  /// can be created from a "+" that appears when hovering one.
  diffEditor?: MonacoEditor.IStandaloneDiffEditor;
}) {
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const wt = worktrees.find((w) => w.id === worktreeId) ?? null;
  // Multi-repo: comments are keyed by (workspaceRoot, branch). Derive
  // the workspace from the worktree we're editing in rather than a
  // global "current workspace."
  const workspace = workspaceForWorktree(wt?.workspaceId);
  const workspaceRoot = workspace?.root ?? "";
  const branch = wt?.branch ?? "";

  const allComments = useCommentsStore((s) => s.items);
  const addComment = useCommentsStore((s) => s.add);
  const updateText = useCommentsStore((s) => s.updateText);
  const removeComment = useCommentsStore((s) => s.remove);
  const resolveComment = useCommentsStore((s) => s.resolve);
  const unresolveComment = useCommentsStore((s) => s.unresolve);
  const toggleThread = useCommentsStore((s) => s.toggleThread);
  const batchKey = reviewKey(workspaceRoot, branch);
  const includedThreads = useCommentsStore(
    (s) => s.includedThreads[batchKey],
  );

  const activeAgentId = useUiStore(
    (s) => s.activeAgentByWorktree[worktreeId] ?? null,
  );

  const showResolved = useUiStore((s) => s.showResolvedComments);

  // "Comment on file" lives in the pane header (so it never covers code);
  // it reaches this overlay as a one-shot request, consumed here.
  const fileCommentRequest = useUiStore((s) => s.fileCommentRequest);
  useEffect(() => {
    if (
      !fileCommentRequest ||
      fileCommentRequest.worktreeId !== worktreeId ||
      fileCommentRequest.path !== filePath
    ) {
      return;
    }
    setComposer({ line: 0, endLine: null, side: "head" });
    useUiStore.getState().clearFileCommentRequest();
  }, [fileCommentRequest, worktreeId, filePath]);
  const [composer, setComposer] = useState<CommentTarget | null>(null);

  // Line mapping for base-side comments; rebuilt whenever the diff
  // recomputes (the agent keeps editing the file).
  const [mapper, setMapper] = useState<ReturnType<typeof baseLineMapper> | null>(null);
  useEffect(() => {
    if (!diffEditor) return;
    const update = () => {
      const changes = diffEditor.getLineChanges();
      setMapper(changes ? baseLineMapper(changes) : null);
    };
    update();
    const sub = diffEditor.onDidUpdateDiff(update);
    return () => sub.dispose();
  }, [diffEditor]);

  /// Where a comment / composer target renders, or null when it can't be
  /// shown in this editor (base-side comments outside a diff view).
  const placement = useCallback(
    (t: { line: number; endLine: number | null; side: CommentSide }) => {
      if (t.line === 0) return { after: 0 };
      const last = t.endLine ?? t.line;
      if (t.side === "head") return { after: last };
      if (!mapper) return null;
      return { after: mapper.afterFor(last), ordinal: BASE_SIDE_ORDINAL };
    },
    [mapper],
  );
  const [entries, setEntries] = useState<ZoneEntry[]>([]);

  const visible = useMemo(() => {
    return allComments.filter(
      (c) =>
        c.workspaceRoot === workspaceRoot &&
        c.branch === branch &&
        c.filePath === filePath &&
        (showResolved || c.resolvedAt === null),
    );
  }, [allComments, workspaceRoot, branch, filePath, showResolved]);

  // Teammates' MR review threads, rendered inline on the lines they commented
  // on (the same threads also appear in the Review tab). Look up the MR for
  // this branch, load its discussions, keep the inline ones anchored here.
  const findMr = useForgeStore((s) => s.findMr);
  const loadThreads = useForgeStore((s) => s.loadThreads);
  const replyThread = useForgeStore((s) => s.replyThread);
  const resolveThread = useForgeStore((s) => s.resolveThread);
  const mr = useForgeStore((s) =>
    workspace ? s.mrByBranch[forgeBranchKey(workspace.id, branch)] : undefined,
  );
  const mrThreads = useForgeStore((s) =>
    workspace && mr ? s.threadsByMr[`${workspace.id}::mr::${mr.number}`] : undefined,
  );
  const terms = useForgeTerms(workspace?.id);

  useEffect(() => {
    if (workspace && branch && mr === undefined) void findMr(workspace.id, branch);
  }, [workspace, branch, mr, findMr]);
  useEffect(() => {
    if (workspace && mr) void loadThreads(workspace.id, mr.number);
  }, [workspace, mr, loadThreads]);

  const fileThreads = useMemo(() => {
    if (!mrThreads) return [] as { thread: ForgeThread; line: number }[];
    const out: { thread: ForgeThread; line: number }[] = [];
    for (const t of mrThreads) {
      const anchored = t.notes.find(
        (n) => n.position?.newPath === filePath && n.position?.newLine != null,
      );
      if (anchored?.position?.newLine != null) {
        out.push({ thread: t, line: anchored.position.newLine });
      }
    }
    return out;
  }, [mrThreads, filePath]);

  const mrNumber = mr ? mr.number : null;
  const onReply = (discussionId: string, body: string) => {
    if (!workspace || mrNumber == null) return Promise.resolve(false);
    return replyThread(workspace.id, mrNumber, discussionId, body);
  };
  const onResolveThread = (discussionId: string, resolved: boolean) => {
    if (!workspace || mrNumber == null) return Promise.resolve(false);
    return resolveThread(workspace.id, mrNumber, discussionId, resolved);
  };

  // Grow a thread's view zone to its measured content height (no cap — match
  // GitLab, which shows the whole thread). `contentPx` is the rendered
  // widget's natural height; add the domNode's vertical padding (6+6).
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const setZoneHeight = useCallback((entry: ZoneEntry, contentPx: number) => {
    const target = Math.ceil(contentPx) + 14;
    if (Math.abs((entry.zone.heightInPx ?? -1) - target) < 2) return;
    entry.zone.heightInLines = undefined;
    entry.zone.heightInPx = target;
    editorRef.current.changeViewZones((acc) => acc.layoutZone(entry.viewZoneId));
  }, []);

  // Track the editor content area (for overlay-widget left/width sync).
  const [layout, setLayout] = useState<{
    contentLeft: number;
    contentWidth: number;
  } | null>(null);
  useEffect(() => {
    const update = () => {
      const info = editor.getLayoutInfo();
      setLayout({
        contentLeft: info.contentLeft,
        contentWidth:
          info.width - info.contentLeft - info.verticalScrollbarWidth,
      });
    };
    update();
    const dispose = editor.onDidLayoutChange(update);
    return () => dispose.dispose();
  }, [editor]);

  // A glyph-margin decoration on every line paints a subtle "+". `filePath`
  // is included in the deps so the decorations are rebuilt against the new
  // model when the user switches files (Monaco reuses the editor instance,
  // but swaps the model — decorations are per-model and would otherwise be
  // lost). `onDidChangeModel` catches any other model swaps.
  useEffect(() => {
    const apply = () => {
      const model = editor.getModel();
      if (!model) return [] as string[];
      const n = model.getLineCount();
      const decorations: MonacoEditor.IModelDeltaDecoration[] = [];
      for (let line = 1; line <= n; line++) {
        decorations.push({
          range: {
            startLineNumber: line,
            startColumn: 1,
            endLineNumber: line,
            endColumn: 1,
          },
          options: {
            glyphMarginClassName: "treehouse-comment-plus",
            stickiness: 1 /* NeverGrowsWhenTypingAtEdges */,
          },
        });
      }
      return editor.deltaDecorations([], decorations);
    };

    let ids = apply();

    const model = editor.getModel();
    const onContent = model?.onDidChangeContent(() => {
      ids = editor.deltaDecorations(ids, []);
      ids = apply();
    });
    const onModel = editor.onDidChangeModel(() => {
      ids = editor.deltaDecorations(ids, []);
      ids = apply();
    });

    return () => {
      onContent?.dispose();
      onModel.dispose();
      editor.deltaDecorations(ids, []);
    };
  }, [editor, filePath]);

  // Click on a "+" decoration opens the composer. Resolve the line number
  // by reading `.line-numbers` text from the same DOM row as the clicked
  // `.cgmr` element — Monaco's `getTargetAtClientPoint` kept returning
  // UNKNOWN for this environment, but the line number is already painted
  // in the gutter as plain text next to every glyph.
  // Click on a "+" decoration opens the composer. Monaco renders glyph
  // decorations in `.glyph-margin-widgets` (a flat container where each
  // `.cgmr` is positioned absolutely via `style.top`). The line numbers
  // live in a parallel container `.margin-view-overlays` whose per-line
  // rows use the same `style.top` values. We match the click's `.cgmr`
  // top to the corresponding `.line-numbers` row and read the number.
  useEffect(() => {
    const handle = (ev: MouseEvent) => {
      const target = ev.target as Element | null;
      // Scope to this editor's DOM. The DiffEditorView mounts two
      // `.monaco-editor` instances side-by-side; without this check a
      // click on either side's gutter would fire every CommentOverlay
      // listening at document-capture phase.
      const editorDom = editor.getDomNode();
      if (!editorDom || !target || !editorDom.contains(target as Node)) return;

      let el = target as HTMLElement | null;
      while (el) {
        if (el.classList?.contains("treehouse-comment-plus")) break;
        el = el.parentElement;
      }
      if (!el) return;

      const monacoRoot = el.closest(".monaco-editor") as HTMLElement | null;
      if (!monacoRoot) return;

      const cgmrTop = el.style.top; // e.g. "36px"
      const marginOverlays = monacoRoot.querySelector(
        ".margin-view-overlays",
      ) as HTMLElement | null;
      if (!marginOverlays) return;

      let match: HTMLElement | null = null;
      for (const child of Array.from(marginOverlays.children) as HTMLElement[]) {
        if (child.style.top === cgmrTop) {
          match = child;
          break;
        }
      }
      const lineEl = match?.querySelector(".line-numbers");
      const line = parseInt((lineEl?.textContent ?? "").trim(), 10);
      if (!Number.isFinite(line) || line < 1) return;

      ev.preventDefault();
      ev.stopPropagation();
      // A multi-line selection that covers the clicked line turns the
      // comment into a range comment (drag down the line numbers, then
      // click "+"). Otherwise it's a single-line comment.
      setComposer(
        rangeFromSelection(editor.getSelection(), line) ?? {
          line,
          endLine: null,
          side: "head",
        },
      );
    };
    // Monaco selects the line on a gutter mousedown, which would clobber
    // the selection a range comment is built from. Swallow mousedown on
    // our "+" before Monaco's own listeners see it.
    const guard = (ev: MouseEvent) => {
      const target = ev.target as Element | null;
      const editorDom = editor.getDomNode();
      if (!editorDom || !target || !editorDom.contains(target as Node)) return;
      if (!target.closest?.(".treehouse-comment-plus")) return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    document.addEventListener("click", handle, true);
    document.addEventListener("mousedown", guard, true);
    return () => {
      document.removeEventListener("click", handle, true);
      document.removeEventListener("mousedown", guard, true);
    };
  }, [editor]);

  // Right-click → "Add Review Comment" on the selection (or cursor line).
  useEffect(() => {
    const action = editor.addAction({
      id: "treehouse.addReviewComment",
      label: "Add Review Comment",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      run: (ed) => {
        const sel = ed.getSelection();
        if (!sel) return;
        setComposer(
          rangeFromSelection(sel, sel.startLineNumber) ?? {
            line: sel.positionLineNumber,
            endLine: null,
            side: "head",
          },
        );
      },
    });
    return () => action.dispose();
  }, [editor]);

  // Tint the lines a range comment covers (and the composer's range while
  // it's open) so it's clear what the comment is about.
  useEffect(() => {
    const ranges: { line: number; endLine: number }[] = [];
    for (const c of visible) {
      if (c.side === "head" && c.endLine !== null && c.resolvedAt === null) {
        ranges.push({ line: c.line, endLine: c.endLine });
      }
    }
    if (composer?.side === "head" && composer.endLine !== null) {
      ranges.push({ line: composer.line, endLine: composer.endLine });
    }
    const ids = editor.deltaDecorations(
      [],
      ranges.map((r) => ({
        range: new monaco.Range(r.line, 1, r.endLine, 1),
        options: {
          isWholeLine: true,
          className: "treehouse-review-range",
          linesDecorationsClassName: "treehouse-review-range-bar",
        },
      })),
    );
    return () => {
      editor.deltaDecorations(ids, []);
    };
  }, [editor, visible, composer]);

  // Hovering a removed line in an inline diff shows a "+" in the gutter
  // for commenting on it. Monaco renders removed code as view zones, not
  // model lines, so the glyph-margin "+" can't reach them; resolve the
  // hovered row to a base line through the diff's line changes instead.
  const [removedHover, setRemovedHover] = useState<{
    top: number;
    after: number;
    baseLine: number;
  } | null>(null);
  const removedPlusRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!diffEditor || !mapper) return;
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const move = editor.onMouseMove((e) => {
      const t = e.target;
      const zoneEl =
        (t.type === monaco.editor.MouseTargetType.GUTTER_VIEW_ZONE ||
          t.type === monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE) &&
        (t.element?.closest(
          ".inline-deleted-margin-view-zone, .view-lines.line-delete",
        ) as HTMLElement | null);
      const editorDom = editor.getDomNode();
      if (!zoneEl || !editorDom) {
        setRemovedHover(null);
        return;
      }
      const after = (t.detail as { afterLineNumber: number }).afterLineNumber;
      const zoneTop = zoneEl.getBoundingClientRect().top;
      const offset = Math.floor((e.event.browserEvent.clientY - zoneTop) / lineHeight);
      const baseLine = mapper.baseLineAt(after, offset);
      if (baseLine === null) {
        setRemovedHover(null);
        return;
      }
      const top = zoneTop + offset * lineHeight - editorDom.getBoundingClientRect().top;
      setRemovedHover((prev) =>
        prev && prev.top === top && prev.baseLine === baseLine
          ? prev
          : { top, after, baseLine },
      );
    });
    const leave = editor.onMouseLeave((e) => {
      const to = e.event.browserEvent.relatedTarget as Node | null;
      if (to && removedPlusRef.current?.contains(to)) return;
      setRemovedHover(null);
    });
    const scroll = editor.onDidScrollChange(() => setRemovedHover(null));
    return () => {
      move.dispose();
      leave.dispose();
      scroll.dispose();
      setRemovedHover(null);
    };
  }, [editor, diffEditor, mapper]);

  // Live zones keyed by `desc.key`, reconciled in place rather than rebuilt.
  // A zone that persists keeps its DOM node, so the portal'd React subtree —
  // and any half-typed text in the composer or a comment's edit box —
  // survives. Rebuilding on every `visible` / `fileThreads` change (the
  // forge poll refreshes threads every 20s; any comment-store write changes
  // `visible`) remounted the composer and wiped in-progress comments.
  const liveRef = useRef(new Map<string, ZoneEntry>());

  // Full teardown only when the editor, file, or model changes. Monaco
  // discards view zones on a model swap, so a reused entry (e.g. the
  // `composer` key) would otherwise keep an overlay pinned to a dead zone;
  // `modelEpoch` forces the reconcile below to recreate them.
  const [modelEpoch, setModelEpoch] = useState(0);
  useEffect(() => {
    const live = liveRef.current;
    const clear = () => {
      for (const e of live.values()) {
        editor.changeViewZones((acc) => acc.removeZone(e.viewZoneId));
        editor.removeOverlayWidget(e.widget);
      }
      live.clear();
    };
    const sub = editor.onDidChangeModel(() => {
      clear();
      setModelEpoch((n) => n + 1);
    });
    return () => {
      sub.dispose();
      clear();
    };
  }, [editor, filePath]);

  useEffect(() => {
    const want: ZoneDesc[] = [];
    for (const c of visible) {
      const at = placement(c);
      if (!at) continue;
      want.push({
        key: `c:${c.id}`,
        kind: "widget",
        ...at,
        heightLines: WIDGET_HEIGHT_LINES,
        comment: c,
      });
    }
    for (const ft of fileThreads) {
      const noteLines = ft.thread.notes.reduce((acc, n) => {
        const newlines = (n.body.match(/\n/g)?.length ?? 0) + 1;
        const wrapped = Math.ceil(n.body.length / 70);
        return acc + 1 + Math.max(newlines, wrapped);
      }, 0);
      want.push({
        key: `t:${ft.thread.id}`,
        kind: "thread",
        after: ft.line,
        // Initial estimate only — `ThreadWidget` measures its real content
        // height after mount and grows the zone to fit (no cap).
        heightLines: Math.max(THREAD_HEIGHT_LINES, 3 + noteLines),
        thread: ft.thread,
      });
    }
    const composerAt = composer && placement(composer);
    if (composer && composerAt) {
      want.push({
        key: "composer",
        kind: "composer",
        ...composerAt,
        heightLines: COMPOSER_HEIGHT_LINES,
        target: composer,
      });
    }

    const live = liveRef.current;
    const wantByKey = new Map(want.map((d) => [d.key, d]));

    // Drop zones that are gone or moved lines (a view zone's anchor line
    // can't be changed in place).
    for (const [key, e] of live) {
      const d = wantByKey.get(key);
      if (!d || d.after !== e.desc.after || d.ordinal !== e.desc.ordinal) {
        editor.changeViewZones((acc) => acc.removeZone(e.viewZoneId));
        editor.removeOverlayWidget(e.widget);
        live.delete(key);
      }
    }

    const info0 = editor.getLayoutInfo();
    const initLeft = info0.contentLeft;
    const initWidth =
      info0.width - info0.contentLeft - info0.verticalScrollbarWidth;
    const next: ZoneEntry[] = [];
    editor.changeViewZones((acc) => {
      for (const desc of want) {
        const existing = live.get(desc.key);
        if (existing) {
          // Same DOM node + zone; just refresh the data it renders. Thread
          // zones keep their measured height (ThreadWidget re-measures).
          const updated = { ...existing, desc };
          live.set(desc.key, updated);
          next.push(updated);
          continue;
        }
        const domNode = document.createElement("div");
        domNode.style.position = "absolute";
        domNode.style.zIndex = "5";
        // Set initial dimensions up-front — Monaco's onDomNodeTop /
        // onComputedHeight callbacks only fire on layout changes and may
        // not run on initial mount, leaving the widget at 0×0 and invisible.
        domNode.style.left = `${initLeft}px`;
        domNode.style.width = `${initWidth}px`;
        domNode.style.top = "0px";
        domNode.style.height = `${desc.heightLines * 18}px`;
        // Recessed band on the chrome surface (bg-chrome / neutral-800
        // hairlines) so review cards read as inserted, not as code.
        domNode.style.background = "#0B0C0E";
        domNode.style.borderTop = "1px solid #22262B";
        domNode.style.borderBottom = "1px solid #22262B";
        domNode.style.boxSizing = "border-box";
        domNode.style.overflow = "auto";
        domNode.style.padding = "6px 12px";

        const widget: MonacoEditor.IOverlayWidget = {
          getId: () => `treehouse.zone.${desc.key}`,
          getDomNode: () => domNode,
          getPosition: () => null,
        };
        editor.addOverlayWidget(widget);

        const spacer = document.createElement("div");
        const zone: MonacoEditor.IViewZone = {
          afterLineNumber: desc.after,
          ordinal: desc.ordinal,
          heightInLines: desc.heightLines,
          domNode: spacer,
          suppressMouseDown: true,
          onDomNodeTop: (top: number) => {
            domNode.style.top = `${top}px`;
          },
          onComputedHeight: (height: number) => {
            domNode.style.height = `${height}px`;
          },
        };
        const viewZoneId = acc.addZone(zone);

        const entry = { desc, viewZoneId, widget, domNode, zone };
        live.set(desc.key, entry);
        next.push(entry);
      }
    });

    setEntries(next);
  }, [editor, visible, composer, placement, fileThreads, modelEpoch]);

  // Keep the overlay widgets' horizontal position/width in sync with the
  // editor's content area as the layout changes (resizes, wrapping toggle,
  // scrollbar appearance, etc).
  useEffect(() => {
    if (!layout) return;
    for (const e of entries) {
      e.domNode.style.left = `${layout.contentLeft}px`;
      e.domNode.style.width = `${layout.contentWidth}px`;
    }
  }, [entries, layout]);

  const glyphLeft = layout ? editor.getLayoutInfo().glyphMarginLeft : 0;

  return (
    <>
      {removedHover && (
        <button
          ref={removedPlusRef}
          onClick={() => {
            setComposer({ line: removedHover.baseLine, endLine: null, side: "base" });
            setRemovedHover(null);
          }}
          onMouseLeave={(e) => {
            if (!editor.getDomNode()?.contains(e.relatedTarget as Node)) {
              setRemovedHover(null);
            }
          }}
          title={`Comment on removed line ${removedHover.baseLine}`}
          aria-label="Comment on removed line"
          style={{ top: removedHover.top, left: glyphLeft + 2 }}
          className="absolute z-20 flex h-[18px] w-[14px] items-center justify-center"
        >
          <span className="flex h-[14px] w-[14px] items-center justify-center rounded bg-blue-600 font-mono text-[12px] font-semibold leading-none text-white">
            +
          </span>
        </button>
      )}
      {entries.map((e) => {
        const desc = e.desc;
        if (desc.kind === "widget") {
          const c = desc.comment;
          return createPortal(
            <CommentWidget
              comment={c}
              status={commentStatus(c)}
              worktreeId={worktreeId}
              activeAgentId={activeAgentId}
              onResolve={() => void resolveComment(c.id)}
              onReopen={() => void unresolveComment(c.id)}
              onDelete={() => void removeComment(c.id)}
              onUpdateText={(text) => void updateText(c.id, text)}
              onSendTo={(agentId) => sendOne(c, agentId)}
            />,
            e.domNode,
            desc.key,
          );
        }
        if (desc.kind === "thread") {
          return createPortal(
            <ThreadWidget
              thread={desc.thread}
              included={includedThreads?.includes(desc.thread.id) ?? false}
              onToggleInclude={() => toggleThread(batchKey, desc.thread.id)}
              onReply={(body) => onReply(desc.thread.id, body)}
              onResolve={(resolved) => onResolveThread(desc.thread.id, resolved)}
              onHeight={(px) => setZoneHeight(e, px)}
            />,
            e.domNode,
            desc.key,
          );
        }
        return createPortal(
          <CommentComposer
            label={targetLabel(desc.target)}
            canSend={activeAgentId !== null}
            postTarget={workspace && mr?.state === "open" ? terms.ref(mr.number) : null}
            onPost={async (text) => {
              if (!workspace || !mr) return;
              setComposer(null);
              const c = await addComment({
                workspaceRoot,
                branch,
                filePath,
                ...desc.target,
                text,
              });
              if (!c) return;
              // Posted → it lives on the MR as a thread now; resolve the
              // local copy, as the batch post does. On failure it stays
              // pending (the store already toasted) for a later retry.
              if (await postCommentsToMr(workspace.id, mr.number, [c])) {
                await resolveComment(c.id);
                toastSuccess(`Posted to ${terms.ref(mr.number)}`);
              }
            }}
            onSave={async (text) => {
              setComposer(null);
              await addComment({
                workspaceRoot,
                branch,
                filePath,
                ...desc.target,
                text,
              });
            }}
            onSaveAndSend={async (text) => {
              setComposer(null);
              const c = await addComment({
                workspaceRoot,
                branch,
                filePath,
                ...desc.target,
                text,
              });
              // No agent attached to this worktree → save still
              // landed; just toast so the user knows the send half
              // didn't fire. `sendOne` would otherwise toast the
              // same thing on a null id, but bypassing it here also
              // skips the resolve.
              if (!c) return;
              if (!activeAgentId) {
                toastInfo(
                  "Comment saved",
                  "No active agent in this worktree to send to.",
                );
                return;
              }
              await sendOne(c, activeAgentId);
            }}
            onCancel={() => setComposer(null)}
          />,
          e.domNode,
          desc.key,
        );
      })}
    </>
  );
}

async function sendOne(c: Comment, agentId: AgentSessionId | null) {
  if (!agentId) {
    toastInfo("Pick an agent to send to");
    return;
  }
  try {
    await pasteAndSubmit(agentId, formatCommentForAgent(c));
    toastSuccess("Sent to agent", anchorLabel(c));
    void useCommentsStore.getState().markSent([c.id]);
  } catch (e) {
    toastError("Couldn't send", asMessage(e));
  }
}

// Shared class recipes for the inline review cards (comment, composer,
// MR thread) so they read as one family with the pane chrome: a raised
// neutral-900 card, a 2px status rail on the leading edge, a 24px header
// strip, and ghost buttons that match `iconButton`'s hover treatment.
const reviewCard =
  "relative overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 text-xs shadow-sm";
const reviewCardRail = "absolute inset-y-0 left-0 w-[2px]";
const reviewCardHeader =
  "flex h-6 items-center justify-between gap-2 border-b border-neutral-800 pl-3 pr-0.5 text-[11px] text-neutral-500";
const reviewGhostButton =
  "flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";
const reviewInput =
  "rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 transition-colors focus:border-blue-500/60 focus:outline-none focus:ring-1 focus:ring-blue-500/30";
const reviewKbd =
  "rounded border border-neutral-700 bg-neutral-950 px-1 font-sans text-[10px] leading-4 text-neutral-400";

/// Read-only render of a teammate's inline MR review thread, anchored on the
/// line they commented on, with a reply box. The same thread also appears in
/// the Review tab. Measures its content and grows the zone to fit (no cap).
function ThreadWidget({
  thread,
  included,
  onToggleInclude,
  onReply,
  onResolve,
  onHeight,
}: {
  thread: ForgeThread;
  /// Whether this thread is pulled into the next review batch.
  included: boolean;
  onToggleInclude: () => void;
  onReply: (body: string) => Promise<boolean>;
  onResolve: (resolved: boolean) => Promise<boolean>;
  onHeight: (px: number) => void;
}) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onHeightRef.current(el.scrollHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [thread]);

  async function submit() {
    const body = reply.trim();
    if (!body) return;
    setBusy(true);
    const ok = await onReply(body);
    setBusy(false);
    if (ok) setReply("");
  }

  async function toggleResolved() {
    setBusy(true);
    await onResolve(!thread.resolved);
    setBusy(false);
  }

  return (
    <div
      ref={ref}
      className={cn(reviewCard, thread.resolved && "opacity-70")}
    >
      <span aria-hidden className={cn(reviewCardRail, "bg-violet-400")} />
      <div className={reviewCardHeader}>
        <span className="flex min-w-0 items-center gap-1.5">
          <GitPullRequest size={12} className="shrink-0 text-violet-400" />
          <span className="font-medium text-neutral-300">MR thread</span>
          <span className={countBadge("neutral")}>{thread.notes.length}</span>
          {included && <span className={countBadge("accent")}>in review</span>}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={onToggleInclude}
          title={
            included
              ? "Remove from the next review batch"
              : "Include this thread in the next review sent to the agent"
          }
          className={cn(
            reviewGhostButton,
            included &&
              "bg-blue-400/15 text-blue-300 hover:bg-blue-400/20 hover:text-blue-200",
          )}
        >
          {included ? "In review" : "Add to review"}
        </button>
        {thread.resolvable && (
          <button
            disabled={busy}
            onClick={() => void toggleResolved()}
            className={cn(
              reviewGhostButton,
              thread.resolved
                ? "text-emerald-400"
                : "hover:bg-emerald-400/10 hover:text-emerald-300",
            )}
          >
            <Check size={12} />
            {thread.resolved ? "Resolved" : "Resolve"}
          </button>
        )}
        </span>
      </div>
      {thread.notes.map((n) => (
        <div
          key={n.id}
          className="border-b border-neutral-800/60 px-3 py-1.5"
        >
          <div className="text-[11px] font-medium text-neutral-400">
            @{n.author}
          </div>
          <div className="whitespace-pre-wrap leading-relaxed text-neutral-200">
            {n.body}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <input
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="Reply…"
          className={cn(reviewInput, "h-6 flex-1 py-0")}
        />
        <button
          disabled={busy || !reply.trim()}
          onClick={() => void submit()}
          className="flex h-6 items-center rounded-md bg-blue-600 px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-blue-600"
        >
          {busy ? "…" : "Reply"}
        </button>
      </div>
    </div>
  );
}

function CommentWidget({
  comment,
  status,
  worktreeId,
  activeAgentId,
  onResolve,
  onReopen,
  onDelete,
  onUpdateText,
  onSendTo,
}: {
  comment: Comment;
  status: CommentStatus;
  worktreeId: WorktreeId;
  activeAgentId: AgentSessionId | null;
  onResolve: () => void;
  onReopen: () => void;
  onDelete: () => void;
  onUpdateText: (text: string) => void;
  onSendTo: (agentId: AgentSessionId) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text);
  const resolved = status === "resolved";

  // Lazily fetched when the picker opens; cached in component state so
  // reopening the same widget's picker doesn't re-shell unless the user
  // explicitly refreshes (closing and reopening clears nothing — we
  // keep the list until the widget unmounts).
  const [agents, setAgents] = useState<AgentSession[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const chevronRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    listAgentsForWorktree(worktreeId)
      .then((list) => {
        if (cancelled) return;
        setAgents(
          list.filter(
            (a) =>
              a.status.kind === "running" || a.status.kind === "starting",
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, worktreeId]);

  // Main Send always routes to the active tab — picking a non-active
  // agent is a one-shot via the popover, not a sticky preference.
  const effectiveTarget = activeAgentId;

  async function sendToTarget(agentId: AgentSessionId) {
    setPickerOpen(false);
    await onSendTo(agentId);
  }

  function save() {
    const t = draft.trim();
    if (!t) return;
    onUpdateText(t);
    setEditing(false);
  }
  function cancelEdit() {
    setDraft(comment.text);
    setEditing(false);
  }

  return (
    <div className={cn(reviewCard, resolved && "opacity-60")}>
      <span
        aria-hidden
        className={cn(
          reviewCardRail,
          status === "pending"
            ? "bg-blue-400"
            : status === "sent"
              ? "bg-neutral-500"
              : "bg-neutral-700",
        )}
      />
      <div className={reviewCardHeader}>
        <span className="flex min-w-0 items-center gap-1.5">
          <MessageSquare size={12} className="shrink-0 text-neutral-500" />
          {/* Keeps a few characters visible when a narrow pane squeezes the
              header; badges and actions don't shrink. */}
          <span className="min-w-[4.5rem] truncate font-mono" title={anchorLabel(comment)}>
            {anchorLabel(comment)}
          </span>
          {comment.side === "base" && (
            <span
              className={cn(countBadge("danger"), "shrink-0")}
              title="On lines removed from the diff base"
            >
              removed
            </span>
          )}
          <span
            className={cn(
              countBadge(status === "pending" ? "accent" : "neutral"),
              "shrink-0",
            )}
            title={
              status === "pending"
                ? "Goes out with the next review from the Review tab"
                : status === "sent"
                  ? "Sent to an agent — resolve once it's addressed"
                  : undefined
            }
          >
            {status}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {!resolved && (
            <span className="relative mr-0.5 inline-flex h-5 overflow-hidden rounded-md border border-neutral-700">
              <button
                onClick={() =>
                  effectiveTarget && void sendToTarget(effectiveTarget)
                }
                disabled={!effectiveTarget}
                title={
                  effectiveTarget
                    ? status === "sent"
                      ? "Send this comment to the active agent again"
                      : "Send just this comment to the active agent now"
                    : "No agents running in this worktree"
                }
                className="flex items-center px-1.5 text-[11px] font-medium text-blue-400 transition-colors hover:bg-blue-400/10 hover:text-blue-300 disabled:cursor-not-allowed disabled:text-neutral-500 disabled:opacity-60 disabled:hover:bg-transparent"
              >
                {status === "sent" ? "Resend" : "Send"}
              </button>
              <button
                ref={chevronRef}
                onClick={() => setPickerOpen((v) => !v)}
                title="Pick agent to send to"
                className={cn(
                  "flex items-center border-l border-neutral-700 px-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200",
                  pickerOpen && "bg-neutral-800 text-neutral-200",
                )}
              >
                <ChevronDown size={12} />
              </button>
              {pickerOpen && chevronRef.current && (
                <SendTargetPopover
                  anchor={chevronRef.current}
                  agents={agents}
                  activeAgentId={activeAgentId}
                  selectedAgentId={effectiveTarget}
                  onPick={sendToTarget}
                  onClose={() => setPickerOpen(false)}
                />
              )}
            </span>
          )}
          {!resolved && (
            <button
              onClick={() => (editing ? save() : setEditing(true))}
              className={reviewGhostButton}
            >
              {editing ? "Save" : "Edit"}
            </button>
          )}
          {!resolved && (
            <button
              onClick={onResolve}
              title="Resolve"
              aria-label="Resolve"
              className={cn(
                reviewGhostButton,
                "w-5 justify-center px-0 hover:bg-emerald-400/10 hover:text-emerald-300",
              )}
            >
              <Check size={12} />
            </button>
          )}
          {resolved && (
            <button onClick={onReopen} className={reviewGhostButton}>
              Reopen
            </button>
          )}
          <button
            onClick={onDelete}
            className={cn(
              reviewGhostButton,
              "w-5 justify-center px-0 hover:bg-rose-400/10 hover:text-rose-400",
            )}
            title="Delete"
            aria-label="Delete"
          >
            <X size={12} />
          </button>
        </span>
      </div>
      <div className="px-3 py-1.5">
        {editing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
            rows={3}
            className={cn(reviewInput, "w-full resize-none")}
          />
        ) : (
          <div className="whitespace-pre-wrap leading-relaxed text-neutral-200">
            {comment.text}
          </div>
        )}
      </div>
    </div>
  );
}

function SendTargetPopover({
  anchor,
  agents,
  activeAgentId,
  selectedAgentId,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  agents: AgentSession[] | null;
  activeAgentId: AgentSessionId | null;
  selectedAgentId: AgentSessionId | null;
  onPick: (id: AgentSessionId) => void | Promise<void>;
  onClose: () => void;
}) {
  const labels = useUiStore((s) => s.agentLabelsBySessionId);
  const ref = useRef<HTMLDivElement>(null);
  // Portaled to document.body — Monaco's overlay widget container has
  // `overflow: auto` and sibling widgets stack on top, so an in-place
  // popover would be clipped or hidden behind the next code line.
  // Pin to the chevron's viewport rect so it floats above everything.
  const POPOVER_WIDTH = 288;
  const rect = anchor.getBoundingClientRect();
  const top = rect.bottom + 4;
  const left = Math.max(8, rect.right - POPOVER_WIDTH);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (ref.current && ref.current.contains(target)) return;
      if (anchor.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // Any scroll while the picker is open will misalign it — close
    // rather than chase the rect on every frame.
    function onScroll() {
      onClose();
    }
    window.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", top, left, width: POPOVER_WIDTH }}
      className="z-50 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 shadow-2xl"
    >
      <div className="border-b border-neutral-800 px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-neutral-500">
        Send to
      </div>
      <div className="max-h-64 overflow-y-auto p-1">
        {agents === null ? (
          <div className="px-3 py-2 text-[11px] text-neutral-500">Loading…</div>
        ) : agents.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-neutral-500">
            No running agents in this worktree
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {agents.map((a) => (
              <li key={a.id}>
                <button
                  onClick={() => void onPick(a.id)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-neutral-800",
                    selectedAgentId === a.id && "bg-blue-400/[0.08]",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <div className="truncate text-neutral-100">
                      {labels[a.id] ?? sendTargetLabel(a)}
                      {a.id === activeAgentId && (
                        <span className="ml-1 text-[10px] text-neutral-500">
                          (active tab)
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[10px] text-neutral-500">
                      {a.argv.join(" ")}
                    </div>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}

function sendTargetLabel(a: AgentSession): string {
  switch (a.backend) {
    case "claudeCode":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "kiro":
      return "Kiro";
  }
}

function CommentComposer({
  label,
  canSend,
  postTarget,
  onPost,
  onSave,
  onSaveAndSend,
  onCancel,
}: {
  /// What the comment will attach to, e.g. "Lines 4–9" or "Whole file".
  label: string;
  /// The open MR/PR to post straight to ("#12" / "!12"), or null for none —
  /// then the "Post to" button is hidden and comments only batch locally.
  postTarget: string | null;
  /// Post this one comment to the MR/PR now, skipping the Review batch.
  onPost: (text: string) => void;
  /// Whether the worktree has an active agent. "Save & send" stays
  /// clickable without one (it saves and toasts), but the tooltip says so.
  canSend: boolean;
  onSave: (text: string) => void;
  /// Save the comment AND immediately fire it off to the active
  /// agent — bound to ⌘⇧↵. Falls back to plain save if the parent
  /// reports there's no agent to target (e.g. you have no running
  /// agents in this worktree).
  onSaveAndSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const empty = text.trim() === "";

  function submit(how: "save" | "send" | "post") {
    const t = text.trim();
    if (!t) return;
    if (how === "send") onSaveAndSend(t);
    else if (how === "post" && postTarget) onPost(t);
    else onSave(t);
  }

  return (
    <div className={cn(reviewCard, "border-blue-400/40")}>
      <span aria-hidden className={cn(reviewCardRail, "bg-blue-400")} />
      <div className={reviewCardHeader}>
        <span className="flex items-center gap-1.5 font-medium text-neutral-300">
          <MessageSquare size={12} className="text-blue-400" />
          New comment
          <span className="font-normal text-neutral-500">· {label}</span>
        </span>
      </div>
      <div className="px-3 pt-1.5">
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (empty) onCancel();
              else submit(e.shiftKey ? "send" : e.altKey && postTarget ? "post" : "save");
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          rows={3}
          placeholder={
            postTarget
              ? `Leave a review comment — save it for the agent, or post it to ${postTarget}…`
              : "Leave a review comment for the agent…"
          }
          className={cn(reviewInput, "w-full resize-none")}
        />
      </div>
      <div className="flex h-8 items-center justify-end gap-1 px-3 pb-0.5">
        <button onClick={onCancel} className={reviewGhostButton}>
          Cancel
          <kbd className={reviewKbd}>Esc</kbd>
        </button>
        <button
          onClick={() => submit("save")}
          disabled={empty}
          className={cn(reviewGhostButton, "border border-neutral-700")}
        >
          Save
          <kbd className={reviewKbd}>⌘↵</kbd>
        </button>
        {postTarget && (
          <button
            onClick={() => submit("post")}
            disabled={empty}
            title={`Post this comment to ${postTarget} now, outside the Review batch`}
            className={cn(reviewGhostButton, "border border-emerald-700/70 text-emerald-200")}
          >
            Post to {postTarget}
            <kbd className={reviewKbd}>⌘⌥↵</kbd>
          </button>
        )}
        <button
          onClick={() => submit("send")}
          disabled={empty}
          title={
            canSend
              ? "Save and send to the active agent"
              : "No active agent in this worktree — saves only"
          }
          className="flex h-5 items-center gap-1.5 rounded bg-blue-600 px-2 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-blue-600"
        >
          Save &amp; send
          <kbd className="rounded border border-white/25 px-1 font-sans text-[10px] leading-4 text-white/80">
            ⌘⇧↵
          </kbd>
        </button>
      </div>
    </div>
  );
}

/// Opt-in LSP wiring. If an LSP config is enabled for this file's Monaco
/// language, spawn (or reuse) a server rooted at the worktree, and tell
/// it about the open document. On path change or unmount, send didClose
/// so the server can drop its cache. Missing binaries toast once per
/// (worktree, language) pair so repeated file opens don't spam.
function useLspIntegration(
  editor: MonacoEditor.IStandaloneCodeEditor | null,
  worktreeId: WorktreeId,
  path: string,
  language: string,
) {
  const configs = useLspStore((s) => s.configs);
  const hasNotifiedNotFound = useLspStore((s) => s.hasNotifiedNotFound);
  const markNotFoundNotified = useLspStore((s) => s.markNotFoundNotified);
  // Re-runs the effect after the "Restart language servers" command
  // disposes the active session — without this dep, the model stays
  // closed against LSP because none of the other deps changed.
  const restartEpoch = useLspStore(
    (s) => s.restartEpoch[worktreeId] ?? 0,
  );
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const worktree = useMemo(
    () => worktrees.find((w) => w.id === worktreeId) ?? null,
    [worktrees, worktreeId],
  );
  const enabledLspLanguages = useSettingsStore(
    (s) => s.settings.enabledLspLanguages,
  );
  const enabledIds = useMemo(
    () => new Set(enabledLspLanguages),
    [enabledLspLanguages],
  );

  useEffect(() => {
    if (!editor || !worktree) return;
    const config = findConfigForLanguage(configs, enabledIds, language);
    if (!config) return;

    // Capture the Monaco model up-front — it may be replaced by the time
    // the cleanup closure runs if the user switches files. The didClose
    // must go out for the URI we actually opened.
    const model = editor.getModel();
    if (!model) return;
    const monacoUriString = model.uri.toString();

    const absolutePath = joinPath(worktree.path, path);
    const lspUri = `file://${absolutePath}`;

    let cancelled = false;

    (async () => {
      try {
        const session = await ensureSession(
          worktreeId,
          config.id,
          lspUri,
          config,
          (text) => {
            // Surface stderr to the devtools console; users rarely need
            // this but it's invaluable when a server misbehaves.
            console.debug(`[lsp ${config.id}]`, text.trimEnd());
          },
        );
        if (cancelled) return;
        await openInSession(session, model, lspUri);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof LspNotFoundError) {
          if (!hasNotifiedNotFound(worktreeId, config.id)) {
            markNotFoundNotified(worktreeId, config.id);
            toastInfo(
              `${config.displayName} not found`,
              err.hint ?? `Install \`${err.command}\` to enable language features`,
            );
          }
        } else {
          console.warn("lsp ensure failed", err);
        }
      }
    })();

    return () => {
      cancelled = true;
      void closeInSession(worktreeId, config.id, monacoUriString);
    };
  }, [
    editor,
    worktreeId,
    path,
    language,
    configs,
    enabledIds,
    worktree,
    restartEpoch,
    hasNotifiedNotFound,
    markNotFoundNotified,
  ]);
}

/// ⌘-click-to-goto: queries LSP ourselves, routes same-file jumps to
/// Monaco's built-in action (which works when called explicitly), and
/// cross-file jumps through the file-selection store so the other file
/// opens with the cursor landing at the definition.
///
/// Monaco's own ⌘-click handler shows the peek underline correctly but
/// stops short of firing the reveal action on click in this embedded
/// setup (root cause unclear — likely a contribution load order thing).
/// Driving it ourselves is reliable.
function useGotoClickHandler(
  editor: MonacoEditor.IStandaloneCodeEditor | null,
  worktreeId: WorktreeId,
  language: string,
) {
  const selectFile = useDiffsStore((s) => s.selectFile);
  const setView = useDiffsStore((s) => s.setView);
  const setPendingReveal = useDiffsStore((s) => s.setPendingReveal);

  useEffect(() => {
    if (!editor) return;
    const sub = editor.onMouseDown(async (e) => {
      const ev = e.event;
      if (!ev.leftButton) return;
      if (!ev.metaKey && !ev.ctrlKey) return;
      if (!e.target.position) return;
      // MouseTargetType.CONTENT_TEXT = 6
      if (e.target.type !== 6) return;

      const model = editor.getModel();
      if (!model) return;

      try {
        const resolved = await resolveDefinition({
          worktreeId,
          languageId: language,
          monacoModelUri: model.uri.toString(),
          lineNumber: e.target.position.lineNumber,
          column: e.target.position.column,
        });
        if (!resolved) return;

        if (resolved.kind === "sameFile") {
          editor.setPosition({
            lineNumber: resolved.line,
            column: resolved.column,
          });
          editor.revealLineInCenter(resolved.line);
          editor.focus();
        } else if (resolved.kind === "inWorktree") {
          setView(worktreeId, "file");
          selectFile(worktreeId, resolved.relPath);
          setPendingReveal(worktreeId, {
            path: resolved.relPath,
            line: resolved.line,
            column: resolved.column,
          });
        }
        // external URIs (e.g. stdlib) aren't opened — no worktree-relative
        // path and no model to load. Future: fetch + mount a read-only
        // model for arbitrary paths.
      } catch (err) {
        console.warn("[lsp] goto click failed", err);
      }
    });
    return () => sub.dispose();
  }, [editor, worktreeId, language, selectFile, setView, setPendingReveal]);
}

/// Consume a `pendingReveal` posted by the cross-file goto handler.
/// Fires once the editor is mounted *and* content for this path has
/// been assigned to the model, so the line we want to reveal actually
/// exists. Clears the pending state on success to avoid re-firing on
/// layout reflows.
function usePendingReveal(
  editor: MonacoEditor.IStandaloneCodeEditor | null,
  worktreeId: WorktreeId,
  path: string,
  content: string,
) {
  const pending = useDiffsStore(
    (s) => s.pendingReveal[worktreeId] ?? null,
  );
  const clearPending = useDiffsStore((s) => s.setPendingReveal);

  useEffect(() => {
    if (!editor || !pending || pending.path !== path) return;
    const model = editor.getModel();
    if (!model) return;
    // Wait until Monaco has swapped to the model for the target file…
    if (!model.uri.toString().endsWith(`/${pending.path}`)) return;
    // …AND the new content has been pushed into that model. Monaco swaps
    // the model URI before the `value` prop sync runs, so there's a brief
    // window where the model's URI matches but its content is still the
    // previous file's text — revealing there lands the cursor on the
    // wrong line and then clears `pending`. Matching on length is cheap
    // and unambiguous since `content` is the truth source for this path.
    if (model.getValue().length !== content.length) return;
    if (model.getLineCount() < pending.line) return;

    const pos = { lineNumber: pending.line, column: pending.column };
    editor.revealLineInCenter(pending.line);
    editor.setPosition(pos);
    editor.focus();
    clearPending(worktreeId, null);
  }, [editor, worktreeId, path, content, pending, clearPending]);
}

function joinPath(base: string, rel: string): string {
  if (!rel) return base;
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const r = rel.startsWith("/") ? rel.slice(1) : rel;
  return `${b}/${r}`;
}

