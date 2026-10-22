import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  FileText,
  Folder,
  ListChecks,
  Pencil,
  Plus,
  Shield,
  ShieldOff,
  Slash,
  Sparkles,
  Square,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { listFiles } from "@/ipc/client";
import type { AcpAttachment, AcpCommand, AcpFollowup, AcpUsage, WorktreeId } from "@/ipc/types";
import {
  activeToken,
  applyCompletion,
  buildPathIndex,
  caretOnEdgeLine,
  formatTokens,
  historyStep,
  mentionedFiles,
  pathSuggestions,
} from "@/lib/acp-prompt";
import {
  currentLabel,
  planToggleTarget,
  type ComposerControls,
  type ComposerPicker,
} from "@/lib/acp-composer";
import { cn } from "@/lib/cn";
import { fuzzyFilter } from "@/lib/fuzzy";

/// Pasted images over this size are refused (they ride the IPC as base64).
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const SUGGESTION_LIMIT = 8;
/// `@` suggestions can be a whole directory listing; the list scrolls.
const PATH_SUGGESTION_LIMIT = 50;

type PastedImage = { mimeType: string; data: string; url: string };

/// The unsent composer contents, held by the caller so they outlive a
/// remount (switching worktrees unmounts the pane).
export type AcpComposerStash = { draft: string; images: PastedImage[]; attached: string[] };

export function emptyComposerStash(): AcpComposerStash {
  return { draft: "", images: [], attached: [] };
}

type Suggestion =
  | { kind: "file"; value: string; dir: boolean }
  | { kind: "command"; value: string; command: AcpCommand };

/// The ACP pane's composer: a roomy prompt field over a toolbar of the
/// agent's session settings (model, effort, permission mode, fast, plan),
/// an attach button, the context meter, and send / stop.
///
/// In the field, `@` completes worktree files (sent as attachments) and,
/// shell-style, directories (Tab into one lists its entries), a
/// leading `/` completes the agent's commands, and pasted images become
/// attachments. ⏎ sends (mid-turn: queues behind the turn), ⌘⏎ interrupts
/// the running turn and sends, ⇧⏎ is a newline, ↑/↓ on the first/last line
/// walk sent prompts, Esc stops a running turn (or closes the suggestion
/// list, or leaves editing). ⌃C, as in the agents' TUIs, stops a running
/// turn (handled pane-wide by the slot) or else clears the draft.
export function AcpPromptBox({
  worktreeId,
  commands,
  controls,
  usage,
  canSend,
  disabled,
  running,
  imagesAllowed,
  onSend,
  onCancel,
  onSetting,
  focusNonce,
  history,
  editRequest,
  insertRequest = null,
  restoreRequest = null,
  requeueRequest = null,
  narrow = false,
  stash,
}: {
  worktreeId: WorktreeId;
  commands: AcpCommand[];
  controls: ComposerControls;
  usage: AcpUsage | null;
  canSend: boolean;
  disabled: boolean;
  running: boolean;
  /// The agent accepts image prompts. Unknown until the session is up;
  /// Rust refuses images if it turns out it doesn't.
  imagesAllowed: boolean;
  /// Resolves false when sending failed (the draft is kept). `interrupt`
  /// cancels the running turn first.
  onSend: (
    text: string,
    attachments: AcpAttachment[],
    interrupt: boolean,
    position?: number,
  ) => Promise<boolean>;
  onCancel: () => void;
  /// Change a session setting through the picker's channel.
  onSetting: (picker: ComposerPicker, value: string) => void;
  /// Bumped to request focus (tab became visible).
  focusNonce: number;
  /// Prompts sent so far, oldest first (see `promptHistory`).
  history: string[];
  /// Load a sent prompt to edit and resend; a new nonce loads again.
  editRequest: { text: string; nonce: number } | null;
  /// Append text to the draft (e.g. an issue reference); a new nonce
  /// inserts again.
  insertRequest?: { text: string; nonce: number } | null;
  /// Edit a held follow-up taken out of the queue (at `position`): sending
  /// puts it back there; Esc puts the original back.
  requeueRequest?: { followup: AcpFollowup; position: number; nonce: number } | null;
  /// Take back prompts that weren't sent (held follow-ups): their text
  /// joins the draft, their attachments the composer's. A new nonce
  /// restores again.
  restoreRequest?: { text: string; attachments: AcpAttachment[]; nonce: number } | null;
  /// Narrow pane: icon-only pickers, shorter copy, no Interrupt button
  /// (⌘⏎ still interrupts).
  narrow?: boolean;
  /// Where the unsent draft is kept across remounts; read on mount.
  stash?: AcpComposerStash;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(() => stash?.draft ?? "");
  const [caret, setCaret] = useState(() => stash?.draft.length ?? 0);
  const [images, setImages] = useState<PastedImage[]>(() => stash?.images ?? []);
  /// Files attached with `+` (absolute paths), beside `@` mentions.
  const [attached, setAttached] = useState<string[]>(() => stash?.attached ?? []);
  useEffect(() => {
    if (!stash) return;
    stash.draft = draft;
    stash.images = images;
    stash.attached = attached;
  }, [stash, draft, images, attached]);
  const [files, setFiles] = useState<string[] | null>(null);
  const loadingFiles = useRef<Promise<string[]> | null>(null);
  const [highlight, setHighlight] = useState(0);
  /// Start offset of a token the user dismissed with Esc.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /// Position while walking `history` with ↑/↓; null = the live draft,
  /// which `savedDraft` holds meanwhile.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const savedDraft = useRef("");
  /// Editing a sent prompt: sending it interrupts a running turn.
  const [editing, setEditing] = useState(false);
  /// Editing a held follow-up: where it goes back to, and as it was.
  const [requeue, setRequeue] = useState<{ followup: AcpFollowup; position: number } | null>(null);
  /// The mode before plan mode was toggled on, to toggle back to.
  const lastNonPlan = useRef<string | null>(null);
  const modeNow = controls.mode?.option.current;
  useEffect(() => {
    if (modeNow && modeNow !== "plan") lastNonPlan.current = modeNow;
  }, [modeNow]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusNonce]);

  useEffect(() => {
    if (!editRequest) return;
    if (requeue) putBack();
    else if (!editing) savedDraft.current = draft;
    setEditing(true);
    setHistoryIndex(null);
    replaceDraft(editRequest.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest?.nonce]);

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

  const pathIndex = useMemo(() => (files ? buildPathIndex(files) : null), [files]);

  const token = activeToken(draft, caret);
  const open = token !== null && token.start !== dismissedAt;
  useEffect(() => {
    if (open && token?.kind === "file") void loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token?.kind]);

  const suggestions: Suggestion[] = useMemo(() => {
    if (!open || !token) return [];
    if (token.kind === "file") {
      if (!pathIndex) return [];
      return pathSuggestions(pathIndex, token.query, PATH_SUGGESTION_LIMIT).map((e) => ({
        kind: "file" as const,
        value: e.path,
        dir: e.dir,
      }));
    }
    return fuzzyFilter(commands, token.query, (c) => c.name, SUGGESTION_LIMIT).map((r) => ({
      kind: "command" as const,
      value: r.item.name,
      command: r.item,
    }));
  }, [open, token?.kind, token?.query, pathIndex, commands]);
  useEffect(() => setHighlight(0), [token?.kind, token?.query]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.children[highlight]?.scrollIntoView?.({ block: "nearest" });
  }, [highlight]);

  function syncCaret() {
    const el = inputRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  }

  // Only inserts requested after mount: a remount (switching planners)
  // mustn't replay the last one.
  const seenInsert = useRef(insertRequest?.nonce);
  useEffect(() => {
    if (!insertRequest || insertRequest.nonce === seenInsert.current) return;
    seenInsert.current = insertRequest.nonce;
    const cur = inputRef.current?.value ?? draft;
    replaceDraft(cur && !/\s$/.test(cur) ? `${cur} ${insertRequest.text}` : `${cur}${insertRequest.text}`);
    setHistoryIndex(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertRequest?.nonce]);

  /// Swap the whole draft, caret at the end.
  function replaceDraft(text: string) {
    pendingCaret.current = text.length;
    setDraft(text);
    setCaret(text.length);
  }

  function walkHistory(dir: -1 | 1) {
    const next = historyStep(history.length, historyIndex, dir);
    if (next === historyIndex) return;
    if (historyIndex === null) savedDraft.current = draft;
    setHistoryIndex(next);
    replaceDraft(next === null ? savedDraft.current : history[next]);
  }

  function stopEditing() {
    if (requeue) {
      putBack();
      setImages(savedAttachments.current.images);
      setAttached(savedAttachments.current.attached);
    }
    setEditing(false);
    replaceDraft(savedDraft.current);
  }

  /// Abandon a follow-up edit: the original goes back to its place.
  function putBack() {
    if (!requeue) return;
    const { followup, position } = requeue;
    setRequeue(null);
    void onSend(followup.text, followup.attachments, false, position);
  }

  // A follow-up edit swaps the composer's attachments too; held here.
  const savedAttachments = useRef<{ images: PastedImage[]; attached: string[] }>({
    images: [],
    attached: [],
  });
  const seenRequeue = useRef(requeueRequest?.nonce);
  useEffect(() => {
    if (!requeueRequest || requeueRequest.nonce === seenRequeue.current) return;
    seenRequeue.current = requeueRequest.nonce;
    if (requeue) putBack();
    else if (!editing) {
      savedDraft.current = inputRef.current?.value ?? draft;
      savedAttachments.current = { images, attached };
    }
    setEditing(false);
    const { followup, position } = requeueRequest;
    setRequeue({ followup, position });
    setHistoryIndex(null);
    replaceDraft(followup.text);
    setAttached(followup.attachments.flatMap((a) => (a.kind === "file" ? [a.path] : [])));
    setImages(
      followup.attachments.flatMap((a) =>
        a.kind === "image"
          ? [{ mimeType: a.mimeType, data: a.data, url: `data:${a.mimeType};base64,${a.data}` }]
          : [],
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requeueRequest?.nonce]);

  function complete(s: Suggestion) {
    if (!token) return;
    const next = applyCompletion(draft, token, s.value);
    pendingCaret.current = next.caret;
    setDraft(next.text);
    setCaret(next.caret);
  }

  async function attachFromDisk() {
    try {
      const picked = await openDialog({ multiple: true, directory: false, title: "Attach files" });
      const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
      setAttached((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))]);
    } catch {
      /* dialog unavailable — nothing to attach */
    }
    inputRef.current?.focus();
  }

  const empty = !draft.trim() && images.length === 0 && attached.length === 0;

  const seenRestore = useRef(restoreRequest?.nonce);
  useEffect(() => {
    if (!restoreRequest || restoreRequest.nonce === seenRestore.current) return;
    seenRestore.current = restoreRequest.nonce;
    const cur = (inputRef.current?.value ?? draft).trim();
    const text = restoreRequest.text.trim();
    replaceDraft(cur && text ? `${text}\n\n${cur}` : text || cur);
    setHistoryIndex(null);
    const files = restoreRequest.attachments.flatMap((a) => (a.kind === "file" ? [a.path] : []));
    const pics = restoreRequest.attachments.flatMap((a) =>
      a.kind === "image"
        ? [{ mimeType: a.mimeType, data: a.data, url: `data:${a.mimeType};base64,${a.data}` }]
        : [],
    );
    if (files.length) setAttached((prev) => [...prev, ...files.filter((f) => !prev.includes(f))]);
    if (pics.length) setImages((prev) => [...prev, ...pics]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreRequest?.nonce]);

  async function send(interrupt = false) {
    if (!canSend || disabled || empty) return;
    const cut = running && (interrupt || editing);
    const text = draft.trim();
    const known = draft.includes("@") ? new Set(await loadFiles()) : new Set<string>();
    const paths = [...mentionedFiles(draft, known), ...attached];
    const attachments: AcpAttachment[] = [
      ...paths
        .filter((p, i) => paths.indexOf(p) === i)
        .map((path) => ({ kind: "file" as const, path })),
      ...images.map((i) => ({ kind: "image" as const, mimeType: i.mimeType, data: i.data })),
    ];
    const sent = { draft, images, attached };
    // An edited follow-up returns to its place (unless it interrupts).
    const position = requeue && !interrupt ? requeue.position : undefined;
    const wasRequeue = requeue;
    const restored = requeue ? { draft: savedDraft.current, ...savedAttachments.current } : null;
    setDraft(restored?.draft ?? "");
    setImages(restored?.images ?? []);
    setAttached(restored?.attached ?? []);
    setNotice(null);
    setHistoryIndex(null);
    setEditing(false);
    setRequeue(null);
    if (!(await onSend(text, attachments, cut, position))) {
      setDraft(sent.draft);
      setImages(sent.images);
      setAttached(sent.attached);
      setRequeue(wasRequeue);
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

  const settingsDisabled = disabled || !canSend;
  const { model, effort, mode, fast, plan, extra } = controls;
  const bypass = mode?.option.current === "bypassPermissions";

  return (
    <div
      className={cn(
        "relative mx-auto w-full max-w-3xl shrink-0 pt-1",
        narrow ? "px-2 pb-2" : "px-3 pb-3",
      )}
    >
      {open && suggestions.length > 0 && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute bottom-full left-3 right-3 z-20 mb-1 max-h-64 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900 py-1 text-[11.5px] shadow-xl shadow-black/40"
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
                "mx-1 flex cursor-pointer items-baseline gap-2 rounded px-2 py-1",
                i === highlight ? "bg-neutral-800 text-neutral-100" : "text-neutral-400",
              )}
            >
              {s.kind === "file" ? (
                <>
                  {s.dir ? (
                    <Folder size={11} className="shrink-0 self-center text-neutral-500" />
                  ) : (
                    <FileText size={11} className="shrink-0 self-center text-neutral-500" />
                  )}
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
        <div className="absolute bottom-full left-3 mb-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-500">
          Loading files…
        </div>
      )}

      <div
        className={cn(
          "rounded-lg border bg-neutral-900 transition-colors",
          disabled ? "border-neutral-800 opacity-60" : "border-neutral-800 focus-within:border-neutral-700",
        )}
      >
        {(editing || requeue) && (
          <div className="flex items-center gap-1.5 border-b border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-400">
            <Pencil size={11} className="shrink-0 text-blue-400" />
            <span className="min-w-0 truncate">
              {requeue
                ? narrow
                  ? "Editing a queued prompt"
                  : "Editing a queued prompt — goes back to its place in the queue"
                : narrow
                  ? "Editing a sent message"
                  : `Editing a sent message — sends as a new message${running ? ", interrupting the current turn" : ""}`}
            </span>
            <button
              onClick={stopEditing}
              title="Stop editing (Esc)"
              aria-label="Stop editing"
              className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
            >
              <X size={10} />
            </button>
          </div>
        )}
        {(images.length > 0 || attached.length > 0) && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {images.map((img, i) => (
              <div key={`img-${i}`} className="group relative">
                <img
                  src={img.url}
                  alt="Pasted"
                  className="h-11 w-11 rounded-md border border-neutral-800 object-cover"
                />
                <RemoveChip
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -right-1.5 -top-1.5"
                />
              </div>
            ))}
            {attached.map((p) => (
              <span
                key={p}
                title={p}
                className="group flex h-6 max-w-[14rem] items-center gap-1.5 rounded-md bg-neutral-800 pl-2 pr-1 text-[11px] text-neutral-300"
              >
                <FileText size={11} className="shrink-0 text-neutral-500" />
                <span className="truncate font-mono">{p.split("/").pop()}</span>
                <RemoveChip onClick={() => setAttached((prev) => prev.filter((x) => x !== p))} />
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={inputRef}
          // The slot reads digits typed here as permission answers while
          // the draft is empty.
          data-acp-composer
          value={draft}
          onChange={(e) => {
            setHistoryIndex(null);
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? 0);
            setDismissedAt(null);
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (isInterruptKey(e) && !running) {
              // Running turns: the slot's pane-wide handler interrupts.
              e.preventDefault();
              if (editing || requeue) stopEditing();
              else {
                setHistoryIndex(null);
                replaceDraft("");
                setImages([]);
                setAttached([]);
              }
              return;
            }
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
            const el = e.currentTarget;
            const at = el.selectionStart ?? 0;
            const collapsed = at === el.selectionEnd;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(e.metaKey || e.ctrlKey);
            } else if (
              e.key === "ArrowUp" &&
              collapsed &&
              (draft === "" || historyIndex !== null) &&
              caretOnEdgeLine(draft, at, "first")
            ) {
              e.preventDefault();
              walkHistory(-1);
            } else if (
              e.key === "ArrowDown" &&
              collapsed &&
              historyIndex !== null &&
              caretOnEdgeLine(draft, at, "last")
            ) {
              e.preventDefault();
              walkHistory(1);
            } else if (e.key === "Escape" && (editing || requeue)) {
              e.preventDefault();
              stopEditing();
            } else if (e.key === "Escape" && running) {
              e.preventDefault();
              onCancel();
            }
          }}
          rows={Math.min(10, Math.max(2, draft.split("\n").length))}
          disabled={disabled}
          placeholder={
            disabled
              ? "Agent exited"
              : running
                ? narrow
                  ? "Follow-up · ⌘⏎ interrupts"
                  : "Queue a follow-up, or ⌘⏎ to interrupt and send"
                : narrow
                  ? "Message, @file, /command"
                  : "Message the agent, tag @files, or use /commands"
          }
          spellCheck={false}
          className="block w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-[13px] leading-relaxed text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
        />

        <div className="flex min-w-0 items-center gap-0.5 px-1.5 pb-1.5">
          <ToolbarButton
            icon={Plus}
            title="Attach files or images"
            onClick={() => void attachFromDisk()}
            disabled={disabled}
          />
          {model && (
            <Picker icon={Sparkles} title="Model" picker={model} disabled={settingsDisabled} onPick={onSetting} compact={narrow} />
          )}
          {effort && (
            <Picker icon={Brain} title="Reasoning effort" picker={effort} disabled={settingsDisabled} onPick={onSetting} compact={narrow} />
          )}
          {mode && (
            <Picker
              icon={bypass ? ShieldOff : Shield}
              title="Permissions"
              picker={mode}
              disabled={settingsDisabled}
              onPick={onSetting}
              tone={bypass ? "warn" : undefined}
              compact={narrow}
            />
          )}
          {extra.map((p) => (
            <Picker key={p.option.id} title={p.option.name} picker={p} disabled={settingsDisabled} onPick={onSetting} compact={narrow} />
          ))}
          {fast && (
            <ToolbarButton
              icon={Zap}
              title={fast.on ? "Fast mode on" : "Fast mode off"}
              active={fast.on}
              disabled={settingsDisabled}
              onClick={() => onSetting(fast.picker, fast.on ? "off" : "on")}
            />
          )}
          {plan && mode && (
            <ToolbarButton
              icon={ListChecks}
              title={plan.active ? "Plan mode on — click to leave" : "Plan mode: plan before making changes"}
              active={plan.active}
              disabled={settingsDisabled}
              onClick={() => onSetting(mode, planToggleTarget(mode.option, lastNonPlan.current))}
            />
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
            {notice && (
              <span className="max-w-[12rem] truncate text-[11px] text-amber-400" title={notice}>
                {notice}
              </span>
            )}
            {usage && <ContextRing usage={usage} />}
            {running && !empty && !editing && !narrow && (
              <button
                onClick={() => void send(true)}
                disabled={!canSend || disabled}
                title="Stop the running turn and send this now (⌘⏎)"
                className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40"
              >
                Interrupt
                <kbd className="font-mono text-[10px] text-neutral-600">⌘⏎</kbd>
              </button>
            )}
            {running && empty ? (
              <button
                onClick={onCancel}
                title="Stop the running turn (Esc or ⌃C)"
                aria-label="Stop"
                className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-200 text-neutral-950 transition-colors hover:bg-white"
              >
                <Square size={9} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={empty || !canSend || disabled}
                title={
                  running && editing
                    ? "Interrupt the turn and send (⏎)"
                    : running
                      ? "Queue this follow-up (⏎)"
                      : "Send (⏎)"
                }
                aria-label="Send"
                className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-600"
              >
                <ArrowUp size={13} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/// ⌃C — the TUIs' interrupt. ⌘C stays copy.
export function isInterruptKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
  return e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c";
}

function RemoveChip({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      title="Remove"
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-neutral-700 text-neutral-300 opacity-0 transition-opacity hover:text-neutral-100 group-hover:opacity-100",
        className,
      )}
    >
      <X size={9} />
    </button>
  );
}

function ToolbarButton({
  icon: Icon,
  title,
  onClick,
  active,
  disabled,
}: {
  icon: LucideIcon;
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "bg-blue-400/15 text-blue-400"
          : "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200",
      )}
    >
      <Icon size={13} />
    </button>
  );
}

/// A toolbar dropdown for one session setting: icon + current value, opening
/// upward into the option list (names, descriptions, a check on the current).
function Picker({
  icon: Icon,
  title,
  picker,
  disabled,
  onPick,
  tone,
  compact = false,
}: {
  icon?: LucideIcon;
  title: string;
  picker: ComposerPicker;
  disabled: boolean;
  onPick: (picker: ComposerPicker, value: string) => void;
  tone?: "warn";
  /// Icon only (the value moves to the tooltip); pickers without an icon
  /// keep a short label.
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const { option } = picker;
  return (
    // Compact: the list anchors to the composer (the nearest positioned
    // ancestor) and spans it, so it can't overflow a narrow pane.
    <div ref={ref} className={cn("min-w-0", !compact && "relative")}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={compact ? `${title}: ${currentLabel(picker.option)}` : title}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
          open ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
          tone === "warn" && "text-amber-400",
        )}
      >
        {Icon && <Icon size={13} className="shrink-0" />}
        {!(compact && Icon) && (
          <span className={cn("truncate", compact ? "max-w-[5rem]" : "max-w-[9rem]")}>
            {currentLabel(option)}
          </span>
        )}
        {!compact && <ChevronDown size={11} className="shrink-0 opacity-60" />}
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={title}
          className={cn(
            "absolute bottom-full z-30 mb-1.5 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 py-1 shadow-xl shadow-black/40",
            compact ? "left-2 right-2" : "left-0 w-64",
          )}
        >
          <div className="px-3 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-neutral-500">
            {title}
          </div>
          {option.options.map((o) => (
            <button
              key={o.value}
              role="option"
              aria-selected={o.value === option.current}
              onClick={() => {
                setOpen(false);
                if (o.value !== option.current) onPick(picker, o.value);
              }}
              className="mx-1 flex w-[calc(100%-0.5rem)] items-start gap-2 rounded px-2 py-1 text-left hover:bg-neutral-800"
            >
              <Check
                size={12}
                className={cn("mt-0.5 shrink-0", o.value === option.current ? "text-blue-400" : "invisible")}
              />
              <span className="min-w-0">
                <span className="block truncate text-[12px] text-neutral-100">{o.name}</span>
                {o.description && (
                  <span className="block text-[11px] leading-snug text-neutral-500">{o.description}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/// Context-window fill as a small ring; tokens (and cost) on hover.
function ContextRing({ usage }: { usage: AcpUsage }) {
  const frac = usage.size > 0 ? Math.min(1, usage.used / usage.size) : 0;
  const pct = Math.round(frac * 100);
  const r = 7;
  const c = 2 * Math.PI * r;
  const cost =
    usage.cost != null
      ? ` · ${usage.currency === "USD" || !usage.currency ? "$" : `${usage.currency} `}${usage.cost.toFixed(2)}`
      : "";
  // neutral-400 → amber-400 → rose-400 as the window fills.
  const color = pct >= 90 ? "#fb7185" : pct >= 70 ? "#fbbf24" : "#9AA1AA";
  return (
    <span
      className="flex h-6 w-6 items-center justify-center"
      title={`Context ${pct}% · ${formatTokens(usage.used)} / ${formatTokens(usage.size)} tokens${cost}`}
      aria-label={`Context ${pct}% used`}
    >
      <svg width="16" height="16" viewBox="0 0 18 18" className="-rotate-90">
        <circle cx="9" cy="9" r={r} fill="none" stroke="#2C3137" strokeWidth="2" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${frac * c} ${c}`}
        />
      </svg>
    </span>
  );
}
