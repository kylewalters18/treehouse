import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FileText, Slash, Square, X } from "lucide-react";

import { listFiles } from "@/ipc/client";
import type { AcpAttachment, AcpCommand, WorktreeId } from "@/ipc/types";
import { activeToken, applyCompletion, mentionedFiles } from "@/lib/acp-prompt";
import { cn } from "@/lib/cn";
import { fuzzyFilter } from "@/lib/fuzzy";

/// Pasted images over this size are refused (they ride the IPC as base64).
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const SUGGESTION_LIMIT = 8;

type PastedImage = { mimeType: string; data: string; url: string };

type Suggestion =
  | { kind: "file"; value: string }
  | { kind: "command"; value: string; command: AcpCommand };

/// The ACP pane's prompt input: `@` completes worktree files (sent as
/// attachments), a leading `/` completes the agent's slash commands, and
/// pasted images become attachments. ⏎ sends, ⇧⏎ is a newline, Esc
/// cancels a running turn (or closes the suggestion list).
export function AcpPromptBox({
  worktreeId,
  commands,
  canSend,
  disabled,
  running,
  imagesAllowed,
  onSend,
  onCancel,
  focusNonce,
}: {
  worktreeId: WorktreeId;
  commands: AcpCommand[];
  canSend: boolean;
  disabled: boolean;
  running: boolean;
  /// The agent accepts image prompts. Unknown until the session is up;
  /// Rust refuses images if it turns out it doesn't.
  imagesAllowed: boolean;
  /// Resolves false when sending failed (the draft is kept).
  onSend: (text: string, attachments: AcpAttachment[]) => Promise<boolean>;
  onCancel: () => void;
  /// Bumped to request focus (tab became visible).
  focusNonce: number;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [images, setImages] = useState<PastedImage[]>([]);
  const [files, setFiles] = useState<string[] | null>(null);
  const loadingFiles = useRef<Promise<string[]> | null>(null);
  const [highlight, setHighlight] = useState(0);
  /// Start offset of a token the user dismissed with Esc.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusNonce]);

  // A completion rewrites the draft; put the caret after the inserted text
  // in the same commit, before any further keystroke lands.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && pendingCaret.current !== null) {
      el.focus();
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [draft]);

  function loadFiles(): Promise<string[]> {
    if (files) return Promise.resolve(files);
    loadingFiles.current ??= listFiles(worktreeId)
      .catch(() => [] as string[])
      .then((f) => {
        setFiles(f);
        return f;
      });
    return loadingFiles.current;
  }

  const token = activeToken(draft, caret);
  const open = token !== null && token.start !== dismissedAt;
  useEffect(() => {
    if (open && token?.kind === "file") void loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token?.kind]);

  const suggestions: Suggestion[] = useMemo(() => {
    if (!open || !token) return [];
    if (token.kind === "file") {
      return fuzzyFilter(files ?? [], token.query, (f) => f, SUGGESTION_LIMIT).map((r) => ({
        kind: "file" as const,
        value: r.item,
      }));
    }
    return fuzzyFilter(commands, token.query, (c) => c.name, SUGGESTION_LIMIT).map((r) => ({
      kind: "command" as const,
      value: r.item.name,
      command: r.item,
    }));
  }, [open, token?.kind, token?.query, files, commands]);
  useEffect(() => setHighlight(0), [token?.kind, token?.query]);

  function syncCaret() {
    const el = inputRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  }

  function complete(s: Suggestion) {
    if (!token) return;
    const next = applyCompletion(draft, token, s.value);
    pendingCaret.current = next.caret;
    setDraft(next.text);
    setCaret(next.caret);
  }

  async function send() {
    if (!canSend || disabled) return;
    const text = draft.trim();
    if (!text && images.length === 0) return;
    const known = draft.includes("@") ? new Set(await loadFiles()) : new Set<string>();
    const attachments: AcpAttachment[] = [
      ...mentionedFiles(draft, known).map((path) => ({ kind: "file" as const, path })),
      ...images.map((i) => ({ kind: "image" as const, mimeType: i.mimeType, data: i.data })),
    ];
    const sentDraft = draft;
    const sentImages = images;
    setDraft("");
    setImages([]);
    setNotice(null);
    if (!(await onSend(text, attachments))) {
      setDraft(sentDraft);
      setImages(sentImages);
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(e.clipboardData.items)
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (pasted.length === 0) return;
    // Keep any text half of the paste; only swallow image-only pastes.
    if (!e.clipboardData.types.includes("text/plain")) e.preventDefault();
    if (!imagesAllowed) {
      setNotice("This agent doesn't accept images.");
      return;
    }
    for (const file of pasted) {
      if (file.size > IMAGE_MAX_BYTES) {
        setNotice("Image is too large (5 MB max).");
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        const data = url.slice(url.indexOf(",") + 1);
        setImages((prev) => [...prev, { mimeType: file.type, data, url }]);
      };
      reader.readAsDataURL(file);
    }
  }

  return (
    <div className="relative shrink-0 border-t border-neutral-800 p-2">
      {open && suggestions.length > 0 && (
        <div
          role="listbox"
          className="absolute bottom-full left-2 right-2 z-10 mb-1 max-h-64 overflow-y-auto rounded-md border border-neutral-700 bg-neutral-900 py-1 text-[11.5px] shadow-2xl"
        >
          {suggestions.map((s, i) => (
            <div
              key={s.value}
              role="option"
              aria-selected={i === highlight}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                complete(s);
              }}
              className={cn(
                "mx-1 flex cursor-pointer items-baseline gap-2 rounded px-1.5 py-1",
                i === highlight ? "bg-neutral-800 text-neutral-100" : "text-neutral-300",
              )}
            >
              {s.kind === "file" ? (
                <>
                  <FileText size={11} className="shrink-0 self-center text-neutral-500" />
                  <span className="truncate font-mono">{s.value}</span>
                </>
              ) : (
                <>
                  <Slash size={11} className="shrink-0 self-center text-neutral-500" />
                  <span className="shrink-0 font-mono">{s.value}</span>
                  {s.command.hint && (
                    <span className="shrink-0 font-mono text-neutral-600">{s.command.hint}</span>
                  )}
                  <span className="min-w-0 truncate text-neutral-500">{s.command.description}</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {open && token?.kind === "file" && files === null && (
        <div className="absolute bottom-full left-2 mb-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-500">
          Loading files…
        </div>
      )}

      {images.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {images.map((img, i) => (
            <div key={i} className="group relative">
              <img
                src={img.url}
                alt="Pasted"
                className="h-12 w-12 rounded border border-neutral-700 object-cover"
              />
              <button
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                title="Remove image"
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900 text-neutral-400 opacity-0 hover:text-neutral-100 group-hover:opacity-100"
              >
                <X size={9} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 p-1.5 focus-within:border-blue-500">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? 0);
            setDismissedAt(null);
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (open && suggestions.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const d = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + d + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                complete(suggestions[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(token?.start ?? null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            } else if (e.key === "Escape" && running) {
              e.preventDefault();
              onCancel();
            }
          }}
          rows={Math.min(8, Math.max(1, draft.split("\n").length))}
          disabled={disabled}
          placeholder={
            disabled ? "Agent exited" : running ? "Queue a follow-up…" : "Message the agent… (@ file, / command)"
          }
          spellCheck={false}
          className="min-w-0 flex-1 resize-none bg-transparent px-1 py-0.5 text-[12.5px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none disabled:opacity-50"
        />
        {running && (
          <button
            onClick={onCancel}
            title="Cancel the running turn (Esc)"
            className="flex h-6 shrink-0 items-center gap-1 rounded border border-neutral-700 px-2 text-[11px] text-neutral-300 hover:bg-neutral-800"
          >
            <Square size={9} fill="currentColor" />
            Cancel
          </button>
        )}
        <button
          onClick={() => void send()}
          disabled={(!draft.trim() && images.length === 0) || !canSend || disabled}
          className="h-6 shrink-0 rounded bg-blue-600 px-2 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </div>
      <div className="flex gap-2 px-1 pt-1 text-[10px] text-neutral-600">
        <span>⏎ send · ⇧⏎ newline · @ file · / command · paste image · Esc cancel</span>
        {notice && <span className="ml-auto text-amber-500">{notice}</span>}
      </div>
    </div>
  );
}
