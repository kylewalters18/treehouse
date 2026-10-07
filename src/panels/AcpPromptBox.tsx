import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  FileText,
  ListChecks,
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
import type { AcpAttachment, AcpCommand, AcpUsage, WorktreeId } from "@/ipc/types";
import { activeToken, applyCompletion, formatTokens, mentionedFiles } from "@/lib/acp-prompt";
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

type PastedImage = { mimeType: string; data: string; url: string };

type Suggestion =
  | { kind: "file"; value: string }
  | { kind: "command"; value: string; command: AcpCommand };

/// The ACP pane's composer: a roomy prompt field over a toolbar of the
/// agent's session settings (model, effort, permission mode, fast, plan),
/// an attach button, the context meter, and send / stop.
///
/// In the field, `@` completes worktree files (sent as attachments), a
/// leading `/` completes the agent's commands, and pasted images become
/// attachments. ⏎ sends, ⇧⏎ is a newline, Esc stops a running turn (or
/// closes the suggestion list).
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
  /// Resolves false when sending failed (the draft is kept).
  onSend: (text: string, attachments: AcpAttachment[]) => Promise<boolean>;
  onCancel: () => void;
  /// Change a session setting through the picker's channel.
  onSetting: (picker: ComposerPicker, value: string) => void;
  /// Bumped to request focus (tab became visible).
  focusNonce: number;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [images, setImages] = useState<PastedImage[]>([]);
  /// Files attached with `+` (absolute paths), beside `@` mentions.
  const [attached, setAttached] = useState<string[]>([]);
  const [files, setFiles] = useState<string[] | null>(null);
  const loadingFiles = useRef<Promise<string[]> | null>(null);
  const [highlight, setHighlight] = useState(0);
  /// Start offset of a token the user dismissed with Esc.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /// The mode before plan mode was toggled on, to toggle back to.
  const lastNonPlan = useRef<string | null>(null);
  const modeNow = controls.mode?.option.current;
  useEffect(() => {
    if (modeNow && modeNow !== "plan") lastNonPlan.current = modeNow;
  }, [modeNow]);

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

  async function send() {
    if (!canSend || disabled || empty) return;
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
    setDraft("");
    setImages([]);
    setAttached([]);
    setNotice(null);
    if (!(await onSend(text, attachments))) {
      setDraft(sent.draft);
      setImages(sent.images);
      setAttached(sent.attached);
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
    <div className="relative shrink-0 px-2.5 pb-2.5 pt-1.5">
      {open && suggestions.length > 0 && (
        <div
          role="listbox"
          className="absolute bottom-full left-2.5 right-2.5 z-20 mb-1 max-h-64 overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 py-1 text-[11.5px] shadow-2xl"
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
        <div className="absolute bottom-full left-2.5 mb-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-500">
          Loading files…
        </div>
      )}

      <div
        className={cn(
          "rounded-xl border bg-[#1b1c1e] transition-colors focus-within:border-neutral-500",
          disabled ? "border-neutral-800 opacity-60" : "border-neutral-700/80",
        )}
      >
        {(images.length > 0 || attached.length > 0) && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {images.map((img, i) => (
              <div key={`img-${i}`} className="group relative">
                <img
                  src={img.url}
                  alt="Pasted"
                  className="h-11 w-11 rounded-md border border-neutral-700 object-cover"
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
                className="group flex h-7 max-w-[14rem] items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 pl-2 pr-1 text-[11px] text-neutral-300"
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
          rows={Math.min(10, Math.max(2, draft.split("\n").length))}
          disabled={disabled}
          placeholder={
            disabled
              ? "Agent exited"
              : running
                ? "Queue a follow-up…"
                : "Message the agent, tag @files, or use /commands"
          }
          spellCheck={false}
          className="block w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[13px] leading-relaxed text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
        />

        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <ToolbarButton
            icon={Plus}
            title="Attach files or images"
            onClick={() => void attachFromDisk()}
            disabled={disabled}
          />
          {model && (
            <Picker icon={Sparkles} title="Model" picker={model} disabled={settingsDisabled} onPick={onSetting} />
          )}
          {effort && (
            <Picker icon={Brain} title="Reasoning effort" picker={effort} disabled={settingsDisabled} onPick={onSetting} />
          )}
          {mode && (
            <Picker
              icon={bypass ? ShieldOff : Shield}
              title="Permissions"
              picker={mode}
              disabled={settingsDisabled}
              onPick={onSetting}
              tone={bypass ? "warn" : undefined}
            />
          )}
          {extra.map((p) => (
            <Picker key={p.option.id} title={p.option.name} picker={p} disabled={settingsDisabled} onPick={onSetting} />
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

          <div className="ml-auto flex items-center gap-1.5 pl-1">
            {notice && <span className="truncate text-[11px] text-amber-500">{notice}</span>}
            {usage && <ContextRing usage={usage} />}
            {running && empty ? (
              <button
                onClick={onCancel}
                title="Stop the running turn (Esc)"
                aria-label="Stop"
                className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-200 text-neutral-900 hover:bg-white"
              >
                <Square size={10} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={empty || !canSend || disabled}
                title={running ? "Queue this follow-up (⏎)" : "Send (⏎)"}
                aria-label="Send"
                className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-200 text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
              >
                <ArrowUp size={14} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RemoveChip({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      title="Remove"
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900 text-neutral-400 opacity-0 hover:text-neutral-100 group-hover:opacity-100",
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
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "bg-neutral-700/70 text-amber-300"
          : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
      )}
    >
      <Icon size={15} />
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
}: {
  icon?: LucideIcon;
  title: string;
  picker: ComposerPicker;
  disabled: boolean;
  onPick: (picker: ComposerPicker, value: string) => void;
  tone?: "warn";
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
    <div ref={ref} className="relative min-w-0">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] disabled:cursor-not-allowed disabled:opacity-40",
          open ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100",
          tone === "warn" && "text-amber-300",
        )}
      >
        {Icon && <Icon size={14} className="shrink-0" />}
        <span className="max-w-[9rem] truncate">{currentLabel(option)}</span>
        <ChevronDown size={12} className="shrink-0 text-neutral-500" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={title}
          className="absolute bottom-full left-0 z-30 mb-1.5 w-64 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-2xl"
        >
          <div className="px-2.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500">
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
              className="mx-1 flex w-[calc(100%-0.5rem)] items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-neutral-800"
            >
              <Check
                size={12}
                className={cn("mt-0.5 shrink-0", o.value === option.current ? "text-neutral-200" : "invisible")}
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
  const color = pct >= 90 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "#d4a373";
  return (
    <span
      className="flex h-7 w-7 items-center justify-center"
      title={`Context ${pct}% · ${formatTokens(usage.used)} / ${formatTokens(usage.size)} tokens${cost}`}
      aria-label={`Context ${pct}% used`}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" className="-rotate-90">
        <circle cx="9" cy="9" r={r} fill="none" stroke="#3f3f46" strokeWidth="2" />
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
