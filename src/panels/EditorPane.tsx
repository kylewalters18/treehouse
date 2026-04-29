import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { THEME_NAME } from "./monaco-theme";
import { listAgentsForWorktree, onDiffUpdated, readFile } from "@/ipc/client";
import { pasteAndSubmit } from "@/lib/agent";
import type {
  AgentSession,
  AgentSessionId,
  Comment,
  FileContent,
  WorktreeId,
} from "@/ipc/types";
import {
  formatCommentForAgent,
  useCommentsStore,
} from "@/stores/comments";
import { useLspStore } from "@/stores/lsp";
import { useUiStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import { asMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";
import { findConfigForLanguage } from "@/lsp/languages";
import {
  LspNotFoundError,
  closeInSession,
  ensureSession,
  openInSession,
  resolveDefinition,
} from "@/lsp/manager";
import { useDiffsStore } from "@/stores/diffs";
import { inferLanguage } from "./editor-language";

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
    // Refresh flag suppresses the initial loading spinner on agent-driven
    // re-reads so the editor doesn't blank out every time the file on
    // disk changes. Only the first read (triggered by `path` change)
    // shows the "Loading…" placeholder.
    const fetch = async (withSpinner: boolean) => {
      if (withSpinner) setLoading(true);
      setError(null);
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
    };

    void fetch(true);

    // Live-refresh on agent writes. `diff_updated` is emitted by the
    // worktree file-watcher after its debounce; when the current file
    // is in the updated diff we re-read it so the editor shows the
    // agent's new content. Monaco's react wrapper no-ops when content
    // is unchanged, so unrelated file changes are free.
    let unlisten: (() => void) | null = null;
    onDiffUpdated(worktreeId, (diff) => {
      if (cancelled) return;
      if (!diff.files.some((f) => f.path === path)) return;
      void fetch(false);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
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
    <div className="relative h-full w-full bg-neutral-950">
      <EditorWithComments
        worktreeId={worktreeId}
        path={path}
        content={content.text}
        language={language}
      />
    </div>
  );
}

// --- Inline review comments (view zone spacer + overlay widget) ---

function EditorWithComments({
  worktreeId,
  path,
  content,
  language,
}: {
  worktreeId: WorktreeId;
  path: string;
  content: string;
  language: string;
}) {
  const [editor, setEditor] = useState<MonacoEditor.IStandaloneCodeEditor | null>(
    null,
  );
  const [cursorPos, setCursorPos] = useState<{
    line: number;
    column: number;
  } | null>(null);
  const onMount: OnMount = (e) => {
    setEditor(e);
    const pos = e.getPosition();
    if (pos) setCursorPos({ line: pos.lineNumber, column: pos.column });
  };

  useLspIntegration(editor, worktreeId, path, language);
  useGotoClickHandler(editor, worktreeId, language);
  usePendingReveal(editor, worktreeId, path, content);

  // Mirror Monaco's cursor position into local state so the bottom-right
  // indicator updates as the user navigates. Monaco fires this for both
  // keyboard motion and click positioning, so one subscription covers all
  // sources.
  useEffect(() => {
    if (!editor) return;
    const sub = editor.onDidChangeCursorPosition((e) => {
      setCursorPos({ line: e.position.lineNumber, column: e.position.column });
    });
    return () => sub.dispose();
  }, [editor]);

  return (
    <>
      <Editor
        height="100%"
        language={language}
        value={content}
        theme={THEME_NAME}
        onMount={onMount}
        path={path}
        options={{
          readOnly: true,
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
      {editor && (
        <CommentOverlay
          editor={editor}
          worktreeId={worktreeId}
          filePath={path}
        />
      )}
      {cursorPos && (
        <div
          className="pointer-events-none absolute bottom-1 right-3 z-20 rounded bg-neutral-900/80 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
          aria-label="Cursor position"
        >
          Ln {cursorPos.line}, Col {cursorPos.column}
        </div>
      )}
    </>
  );
}

type ZoneDesc =
  | { key: string; kind: "widget"; line: number; heightLines: number; comment: Comment }
  | { key: string; kind: "composer"; line: number; heightLines: number };

type ZoneEntry = {
  desc: ZoneDesc;
  viewZoneId: string;
  widget: MonacoEditor.IOverlayWidget;
  domNode: HTMLDivElement;
};

const WIDGET_HEIGHT_LINES = 5;
const COMPOSER_HEIGHT_LINES = 6;

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
}: {
  editor: MonacoEditor.IStandaloneCodeEditor;
  worktreeId: WorktreeId;
  filePath: string;
}) {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const wt = worktrees.find((w) => w.id === worktreeId) ?? null;
  const workspaceRoot = workspace?.root ?? "";
  const branch = wt?.branch ?? "";

  const allComments = useCommentsStore((s) => s.items);
  const queue = useCommentsStore((s) => s.queue);
  const addComment = useCommentsStore((s) => s.add);
  const updateText = useCommentsStore((s) => s.updateText);
  const removeComment = useCommentsStore((s) => s.remove);
  const resolveComment = useCommentsStore((s) => s.resolve);
  const toggleQueue = useCommentsStore((s) => s.toggleQueue);

  const activeAgentId = useUiStore(
    (s) => s.activeAgentByWorktree[worktreeId] ?? null,
  );

  const [showResolved, setShowResolved] = useState(false);
  const [composerLine, setComposerLine] = useState<number | null>(null);
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
      setComposerLine(line);
    };
    document.addEventListener("click", handle, true);
    return () => document.removeEventListener("click", handle, true);
  }, [editor]);

  // Build the set of zones (view zone + overlay widget pairs) that should
  // exist right now, and reconcile against what's already there. The full
  // rebuild is cheap because the set is small.
  useEffect(() => {
    const prev = entries;
    for (const e of prev) {
      editor.changeViewZones((acc) => acc.removeZone(e.viewZoneId));
      editor.removeOverlayWidget(e.widget);
    }

    const want: ZoneDesc[] = [];
    for (const c of visible) {
      want.push({
        key: `c:${c.id}`,
        kind: "widget",
        line: c.line,
        heightLines: WIDGET_HEIGHT_LINES,
        comment: c,
      });
    }
    if (composerLine !== null) {
      want.push({
        key: "composer",
        kind: "composer",
        line: composerLine,
        heightLines: COMPOSER_HEIGHT_LINES,
      });
    }

    const next: ZoneEntry[] = [];
    const info0 = editor.getLayoutInfo();
    const initLeft = info0.contentLeft;
    const initWidth =
      info0.width - info0.contentLeft - info0.verticalScrollbarWidth;
    editor.changeViewZones((acc) => {
      for (const desc of want) {
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
        domNode.style.background = "#191A1B";
        domNode.style.borderTop = "1px solid #2A2B2C";
        domNode.style.borderBottom = "1px solid #2A2B2C";
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
        const viewZoneId = acc.addZone({
          afterLineNumber: desc.line,
          heightInLines: desc.heightLines,
          domNode: spacer,
          suppressMouseDown: true,
          onDomNodeTop: (top: number) => {
            domNode.style.top = `${top}px`;
          },
          onComputedHeight: (height: number) => {
            domNode.style.height = `${height}px`;
          },
        });

        next.push({ desc, viewZoneId, widget, domNode });
      }
    });

    setEntries(next);

    return () => {
      for (const e of next) {
        editor.changeViewZones((acc) => acc.removeZone(e.viewZoneId));
        editor.removeOverlayWidget(e.widget);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, visible, composerLine]);

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

  return (
    <>
      <button
        onClick={() => setShowResolved((v) => !v)}
        className={cn(
          "pointer-events-auto absolute right-3 top-2 z-20 rounded border border-neutral-800 bg-neutral-900/80 px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800",
          showResolved && "text-neutral-200",
        )}
        title={
          showResolved
            ? "Hide resolved comments"
            : "Show resolved comments in this file"
        }
      >
        {showResolved ? "Hide resolved" : "Show resolved"}
      </button>
      {entries.map((e) => {
        const desc = e.desc;
        if (desc.kind === "widget") {
          const c = desc.comment;
          return createPortal(
            <CommentWidget
              comment={c}
              queued={queue.has(c.id)}
              worktreeId={worktreeId}
              activeAgentId={activeAgentId}
              onToggleQueue={() => toggleQueue(c.id)}
              onResolve={() => void resolveComment(c.id)}
              onDelete={() => void removeComment(c.id)}
              onUpdateText={(text) => void updateText(c.id, text)}
              onSendTo={(agentId) => sendOne(c, agentId)}
            />,
            e.domNode,
            desc.key,
          );
        }
        return createPortal(
          <CommentComposer
            onSave={async (text) => {
              setComposerLine(null);
              await addComment({
                workspaceRoot,
                branch,
                filePath,
                line: desc.line,
                text,
              });
            }}
            onCancel={() => setComposerLine(null)}
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
    toastSuccess("Sent to agent", `${c.filePath}:${c.line}`);
    void useCommentsStore.getState().resolve(c.id);
  } catch (e) {
    toastError("Couldn't send", asMessage(e));
  }
}

function CommentWidget({
  comment,
  queued,
  worktreeId,
  activeAgentId,
  onToggleQueue,
  onResolve,
  onDelete,
  onUpdateText,
  onSendTo,
}: {
  comment: Comment;
  queued: boolean;
  worktreeId: WorktreeId;
  activeAgentId: AgentSessionId | null;
  onToggleQueue: () => void;
  onResolve: () => void;
  onDelete: () => void;
  onUpdateText: (text: string) => void;
  onSendTo: (agentId: AgentSessionId) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text);
  const resolved = comment.resolvedAt !== null;

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
    <div
      className={cn(
        "rounded border bg-neutral-950 text-xs",
        resolved ? "border-neutral-900 opacity-60" : "border-neutral-800",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-neutral-900 px-2 py-1 text-[11px] text-neutral-500">
        <span className="font-mono">
          {comment.filePath}:{comment.line}
          {resolved && (
            <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400">
              resolved
            </span>
          )}
          {queued && !resolved && (
            <span className="ml-2 rounded bg-blue-900/50 px-1.5 py-0.5 text-[11px] text-blue-300">
              queued
            </span>
          )}
        </span>
        <span className="flex items-center gap-1">
          {!resolved && (
            <span className="relative inline-flex">
              <button
                onClick={() =>
                  effectiveTarget && void sendToTarget(effectiveTarget)
                }
                disabled={!effectiveTarget}
                title={
                  effectiveTarget
                    ? "Send to selected agent"
                    : "No agents running in this worktree"
                }
                className="rounded-l border border-r-0 border-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-300 hover:border-emerald-800 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send
              </button>
              <button
                ref={chevronRef}
                onClick={() => setPickerOpen((v) => !v)}
                title="Pick agent to send to"
                className="rounded-r border border-neutral-800 px-1 py-0.5 text-[11px] text-neutral-400 hover:border-emerald-800 hover:text-emerald-300"
              >
                ▾
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
              onClick={onToggleQueue}
              className={cn(
                "rounded border px-1.5 py-0.5 text-[11px]",
                queued
                  ? "border-blue-700 bg-blue-950/40 text-blue-200 hover:bg-blue-950/60"
                  : "border-neutral-800 text-neutral-400 hover:border-blue-800 hover:text-blue-300",
              )}
              title={queued ? "Remove from queue" : "Add to batch"}
            >
              {queued ? "Queued" : "Queue"}
            </button>
          )}
          {!resolved && (
            <button
              onClick={() => (editing ? save() : setEditing(true))}
              className="rounded border border-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200"
            >
              {editing ? "Save" : "Edit"}
            </button>
          )}
          {!resolved && (
            <button
              onClick={onResolve}
              className="rounded border border-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
            >
              Resolve
            </button>
          )}
          <button
            onClick={onDelete}
            className="text-[11px] text-neutral-500 hover:text-red-400"
            title="Delete"
          >
            ✕
          </button>
        </span>
      </div>
      <div className="px-2 py-1">
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
            className="w-full resize-none rounded border border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-200 focus:border-neutral-700 focus:outline-none"
          />
        ) : (
          <div className="whitespace-pre-wrap text-neutral-200">
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
      className="z-50 rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl"
    >
      <div className="border-b border-neutral-800 px-3 py-2 text-[11px] uppercase tracking-wider text-neutral-500">
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
                    "flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-950",
                    selectedAgentId === a.id && "bg-blue-950/40",
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
  onSave,
  onCancel,
}: {
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="rounded border border-blue-800 bg-neutral-950">
      <div className="border-b border-neutral-900 px-2 py-1 text-[11px] text-neutral-500">
        New comment · ⌘↵ to save · Esc to cancel
      </div>
      <div className="px-2 py-1">
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              const t = text.trim();
              if (t) onSave(t);
              else onCancel();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          rows={3}
          placeholder="Leave a review comment for the agent…"
          className="w-full resize-none rounded border border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none"
        />
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
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const worktree = useMemo(
    () => worktrees.find((w) => w.id === worktreeId) ?? null,
    [worktrees, worktreeId],
  );

  useEffect(() => {
    if (!editor || !worktree) return;
    const config = findConfigForLanguage(configs, language);
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
    worktree,
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

