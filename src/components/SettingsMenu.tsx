import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/stores/settings";
import { useLspStore } from "@/stores/lsp";
import type {
  AgentBackendKind,
  LspConfig,
  MergeBackStrategy,
  SyncStrategy,
} from "@/ipc/types";
import { cn } from "@/lib/cn";

const SYNC_OPTIONS: { value: SyncStrategy; label: string; sub: string }[] = [
  { value: "rebase", label: "Rebase", sub: "git rebase default; auto-aborts on conflict" },
  { value: "merge", label: "Merge", sub: "git merge default; conflicts left in workdir" },
];

const MERGE_OPTIONS: { value: MergeBackStrategy; label: string; sub: string }[] = [
  { value: "rebaseFf", label: "Rebase + ff", sub: "rebase agent branch then --ff-only merge" },
  { value: "mergeNoFf", label: "Merge commit", sub: "git merge --no-ff" },
  { value: "squash", label: "Squash + commit", sub: "git merge --squash + your message" },
];

const AGENT_OPTIONS: { value: AgentBackendKind; label: string; sub: string }[] = [
  { value: "claudeCode", label: "Claude Code", sub: "claude" },
  { value: "codex", label: "Codex", sub: "codex" },
  { value: "kiro", label: "Kiro", sub: "kiro-cli" },
];

export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const settings = useSettingsStore((s) => s.settings);
  const setSync = useSettingsStore((s) => s.setSyncStrategy);
  const setMerge = useSettingsStore((s) => s.setMergeBackStrategy);
  const setInitSubmodules = useSettingsStore((s) => s.setInitSubmodules);
  const setDefaultAgent = useSettingsStore((s) => s.setDefaultAgentBackend);

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
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "rounded border px-2 py-1 text-neutral-400 hover:bg-neutral-800",
          open ? "border-neutral-600 bg-neutral-800" : "border-neutral-700",
        )}
        title="Settings"
      >
        ⚙
      </button>
      {open && (
        <div className="absolute right-0 top-[110%] z-30 w-72 rounded-lg border border-neutral-800 bg-neutral-900 p-3 shadow-2xl">
          <Section
            label="Default Sync strategy"
            options={SYNC_OPTIONS}
            value={settings.syncStrategy}
            onChange={(v) => void setSync(v)}
          />
          <div className="mt-3 border-t border-neutral-800 pt-3">
            <Section
              label="Default Merge strategy"
              options={MERGE_OPTIONS}
              value={settings.mergeBackStrategy}
              onChange={(v) => void setMerge(v)}
            />
          </div>
          <div className="mt-3 border-t border-neutral-800 pt-3">
            <Section
              label="Default agent"
              options={AGENT_OPTIONS}
              value={settings.defaultAgentBackend}
              onChange={(v) => void setDefaultAgent(v)}
            />
          </div>
          <div className="mt-3 border-t border-neutral-800 pt-3">
            <label className="flex cursor-pointer items-start gap-2 rounded border border-neutral-800 px-2 py-1.5 text-xs hover:bg-neutral-950">
              <input
                type="checkbox"
                checked={settings.initSubmodules}
                onChange={(e) => void setInitSubmodules(e.target.checked)}
                className="mt-0.5 accent-blue-600"
              />
              <span className="flex-1">
                <div className="font-medium text-neutral-100">
                  Initialize submodules on create
                </div>
                <div className="font-mono text-[11px] text-neutral-500">
                  git submodule update --init --recursive
                </div>
              </span>
            </label>
          </div>
          <div className="mt-3 border-t border-neutral-800 pt-3">
            <LanguagesSection />
          </div>
        </div>
      )}
    </div>
  );
}

function LanguagesSection() {
  const [open, setOpen] = useState(false);
  const configs = useLspStore((s) => s.configs);
  const resolved = useLspStore((s) => s.resolved);
  const save = useLspStore((s) => s.save);
  const load = useLspStore((s) => s.load);

  useEffect(() => {
    if (open && configs.length === 0) void load();
  }, [open, configs.length, load]);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-[11px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300"
      >
        <span>Languages (LSP)</span>
        <span>{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="mt-2 flex max-h-64 flex-col gap-1 overflow-auto">
          {configs.length === 0 && (
            <div className="px-2 py-1 text-[11px] text-neutral-500">
              Loading…
            </div>
          )}
          {configs.map((c) => (
            <LanguageRow
              key={c.id}
              config={c}
              resolvedPath={resolved[c.command]}
              onToggle={(enabled) => void save({ ...c, enabled })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LanguageRow({
  config,
  resolvedPath,
  onToggle,
}: {
  config: LspConfig;
  resolvedPath: string | null | undefined;
  onToggle: (enabled: boolean) => void;
}) {
  const found = resolvedPath !== null && resolvedPath !== undefined;
  const checking = resolvedPath === undefined;
  const statusColor = !config.enabled
    ? "bg-neutral-700"
    : checking
      ? "bg-neutral-500"
      : found
        ? "bg-emerald-500"
        : "bg-red-500";
  const statusLabel = !config.enabled
    ? "disabled"
    : checking
      ? "checking…"
      : found
        ? `found at ${resolvedPath}`
        : config.installHint
          ? `not found — ${config.installHint}`
          : "not found on PATH";
  return (
    <label
      className="flex cursor-pointer items-start gap-2 rounded border border-neutral-800 px-2 py-1.5 text-xs hover:bg-neutral-950"
      title={statusLabel}
    >
      <input
        type="checkbox"
        checked={config.enabled}
        onChange={(e) => onToggle(e.target.checked)}
        className="mt-0.5 accent-blue-600"
      />
      <span className="flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn("h-2 w-2 rounded-full", statusColor)} />
          <div className="font-medium text-neutral-100">{config.displayName}</div>
        </div>
        <div className="truncate font-mono text-[11px] text-neutral-500">
          {config.enabled ? statusLabel : `${config.command} ${config.args.join(" ")}`.trim()}
        </div>
      </span>
    </label>
  );
}

function Section<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; sub: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div className="flex flex-col gap-1">
        {options.map((opt) => (
          <label
            key={opt.value}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 text-xs",
              opt.value === value
                ? "border-blue-700 bg-blue-950/30"
                : "border-neutral-800 hover:bg-neutral-950",
            )}
          >
            <input
              type="radio"
              checked={opt.value === value}
              onChange={() => onChange(opt.value)}
              className="mt-0.5 accent-blue-600"
            />
            <span className="flex-1">
              <div className="font-medium text-neutral-100">{opt.label}</div>
              <div className="font-mono text-[11px] text-neutral-500">
                {opt.sub}
              </div>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
