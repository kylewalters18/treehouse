import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { agentWrite, readFile } from "@/ipc/client";
import type { Comment, FileContent, WorktreeId } from "@/ipc/types";
import {
  formatCommentForAgent,
  useCommentsStore,
} from "@/stores/comments";
import { useUiStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useWorktreesStore } from "@/stores/worktrees";
import { toastError, toastInfo, toastSuccess } from "@/stores/toasts";
import { asMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";

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
  const onMount: OnMount = (e) => setEditor(e);

  return (
    <>
      <Editor
        height="100%"
        language={language}
        value={content}
        theme={THEME_NAME}
        beforeMount={defineTreehouseTheme}
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
function CommentOverlay({
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
        domNode.style.background = "#0f0f0f";
        domNode.style.borderTop = "1px solid #262626";
        domNode.style.borderBottom = "1px solid #262626";
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
          "pointer-events-auto absolute right-3 top-2 z-20 rounded border border-neutral-800 bg-neutral-900/80 px-2 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-800",
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
              canSend={!!activeAgentId}
              onToggleQueue={() => toggleQueue(c.id)}
              onResolve={() => void resolveComment(c.id)}
              onDelete={() => void removeComment(c.id)}
              onUpdateText={(text) => void updateText(c.id, text)}
              onSend={() => sendOne(c, activeAgentId)}
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

async function sendOne(c: Comment, agentId: string | null) {
  if (!agentId) {
    toastInfo("No active agent in this worktree");
    return;
  }
  try {
    const enc = new TextEncoder();
    await agentWrite(agentId, enc.encode(formatCommentForAgent(c)));
    toastSuccess("Sent to agent", `${c.filePath}:${c.line}`);
    void useCommentsStore.getState().resolve(c.id);
  } catch (e) {
    toastError("Couldn't send", asMessage(e));
  }
}

function CommentWidget({
  comment,
  queued,
  canSend,
  onToggleQueue,
  onResolve,
  onDelete,
  onUpdateText,
  onSend,
}: {
  comment: Comment;
  queued: boolean;
  canSend: boolean;
  onToggleQueue: () => void;
  onResolve: () => void;
  onDelete: () => void;
  onUpdateText: (text: string) => void;
  onSend: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text);
  const resolved = comment.resolvedAt !== null;

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
        "rounded border bg-neutral-950 text-[13px]",
        resolved ? "border-neutral-900 opacity-60" : "border-neutral-800",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-neutral-900 px-2 py-1 text-[11px] text-neutral-500">
        <span className="font-mono">
          {comment.filePath}:{comment.line}
          {resolved && (
            <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
              resolved
            </span>
          )}
          {queued && !resolved && (
            <span className="ml-2 rounded bg-blue-900/50 px-1.5 py-0.5 text-[10px] text-blue-300">
              queued
            </span>
          )}
        </span>
        <span className="flex items-center gap-1">
          {!resolved && (
            <button
              onClick={onSend}
              disabled={!canSend}
              title={canSend ? "Send to active agent" : "No active agent"}
              className="rounded border border-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-300 hover:border-emerald-800 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
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
            className="w-full resize-none rounded border border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-[12px] text-neutral-200 focus:border-neutral-700 focus:outline-none"
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
          className="w-full resize-none rounded border border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none"
        />
      </div>
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
