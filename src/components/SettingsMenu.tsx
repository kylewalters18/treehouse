import { useEffect, useMemo, useState } from "react";
import { useSettingsStore } from "@/stores/settings";
import { useLspStore } from "@/stores/lsp";
import { useForgeStore } from "@/stores/forge";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { useWorkspaceStore, workspaceForWorktree } from "@/stores/workspace";
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

type Category = "workflow" | "agents" | "languages" | "forge";
const CATEGORIES: { id: Category; label: string }[] = [
  { id: "workflow", label: "Workflow" },
  { id: "agents", label: "Agents" },
  { id: "languages", label: "Languages" },
  { id: "forge", label: "Forge" },
];

/// Settings as a categorized modal: a left rail of sections + a content pane
/// that scrolls on its own, so a long list (Languages) never drags the rest.
export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<Category>("workflow");
  const settings = useSettingsStore((s) => s.settings);
  const setSync = useSettingsStore((s) => s.setSyncStrategy);
  const setMerge = useSettingsStore((s) => s.setMergeBackStrategy);
  const setInitSubmodules = useSettingsStore((s) => s.setInitSubmodules);
  const setDefaultAgent = useSettingsStore((s) => s.setDefaultAgentBackend);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          "rounded border px-2 py-1 text-neutral-400 hover:bg-neutral-800",
          open ? "border-neutral-600 bg-neutral-800" : "border-neutral-700",
        )}
        title="Settings"
      >
        ⚙
      </button>
      {open && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/50"
          onMouseDown={() => setOpen(false)}
        >
          <div
            className="flex h-[34rem] max-h-[82vh] w-[44rem] overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Category rail */}
            <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-neutral-800 bg-neutral-950/40 p-2">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                Settings
              </div>
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActive(c.id)}
                  className={cn(
                    "rounded px-2 py-1.5 text-left text-xs",
                    active === c.id
                      ? "bg-neutral-800 text-neutral-100"
                      : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200",
                  )}
                >
                  {c.label}
                </button>
              ))}
              <span className="flex-1" />
              <button
                onClick={() => setOpen(false)}
                className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
              >
                Done
              </button>
            </nav>

            {/* Content pane (scrolls independently) */}
            <div className="flex-1 overflow-y-auto p-4">
              {active === "workflow" && (
                <div className="flex flex-col gap-4">
                  <Section
                    label="Default sync strategy"
                    options={SYNC_OPTIONS}
                    value={settings.syncStrategy}
                    onChange={(v) => void setSync(v)}
                  />
                  <Section
                    label="Default merge strategy"
                    options={MERGE_OPTIONS}
                    value={settings.mergeBackStrategy}
                    onChange={(v) => void setMerge(v)}
                  />
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
              )}

              {active === "agents" && (
                <Section
                  label="Default agent"
                  options={AGENT_OPTIONS}
                  value={settings.defaultAgentBackend}
                  onChange={(v) => void setDefaultAgent(v)}
                />
              )}

              {active === "languages" && <LanguagesPane />}
              {active === "forge" && <ForgePane />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/// Forge availability/auth for the active workspace.
function ForgePane() {
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId);
  const worktrees = useWorktreesStore((s) => s.worktrees);
  const selected = worktrees.find((w) => w.id === selectedWorktreeId) ?? null;
  const activeWorkspace =
    workspaceForWorktree(selected?.workspaceId) ??
    useWorkspaceStore.getState().workspaces[0] ??
    null;
  const status = useForgeStore((s) =>
    activeWorkspace ? s.status[activeWorkspace.id] : undefined,
  );
  const loadStatus = useForgeStore((s) => s.loadStatus);

  useEffect(() => {
    if (activeWorkspace) void loadStatus(activeWorkspace.id);
  }, [activeWorkspace, loadStatus]);

  const kindLabel =
    status?.kind === "gitlab"
      ? "GitLab"
      : status?.kind === "github"
        ? "GitHub"
        : "—";

  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-wider text-neutral-500">
        Forge
      </div>
      <div className="rounded border border-neutral-800 px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              !status
                ? "bg-neutral-600"
                : status.authenticated
                  ? "bg-emerald-500"
                  : status.installed
                    ? "bg-amber-500"
                    : "bg-red-500",
            )}
          />
          <span className="font-medium text-neutral-100">{kindLabel}</span>
          {status?.host && (
            <span className="font-mono text-[11px] text-neutral-500">
              {status.host}
            </span>
          )}
          {status?.username && (
            <span className="text-[11px] text-neutral-500">@{status.username}</span>
          )}
        </div>
        <div className="mt-1 font-mono text-[11px] text-neutral-500">
          {!status
            ? "checking…"
            : status.authenticated
              ? "authenticated"
              : status.kind === "gitlab"
                ? status.installed
                  ? "token invalid or expired"
                  : "no token in ~/.netrc for this host"
                : status.installed
                  ? "not signed in — gh auth login"
                  : "gh not installed"}
        </div>
      </div>
      <p className="mt-2 text-[11px] text-neutral-600">
        GitLab auth is a personal access token in{" "}
        <code className="font-mono">~/.netrc</code> (per host); GitHub uses the{" "}
        <code className="font-mono">gh</code> CLI.
      </p>
    </div>
  );
}

function LanguagesPane() {
  const configs = useLspStore((s) => s.configs);
  const resolved = useLspStore((s) => s.resolved);
  const load = useLspStore((s) => s.load);
  const settings = useSettingsStore((s) => s.settings);
  const setEnabledLanguages = useSettingsStore((s) => s.setEnabledLspLanguages);

  useEffect(() => {
    if (configs.length === 0) void load();
  }, [configs.length, load]);

  const enabledSet = useMemo(
    () => new Set(settings.enabledLspLanguages),
    [settings.enabledLspLanguages],
  );

  function toggle(id: string, on: boolean) {
    const next = new Set(enabledSet);
    if (on) next.add(id);
    else next.delete(id);
    void setEnabledLanguages([...next].sort());
  }

  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-wider text-neutral-500">
        Languages (LSP)
      </div>
      <div className="flex flex-col gap-1">
        {configs.length === 0 && (
          <div className="px-2 py-1 text-[11px] text-neutral-500">Loading…</div>
        )}
        {configs.map((c) => (
          <LanguageRow
            key={c.id}
            config={c}
            enabled={enabledSet.has(c.id)}
            resolvedPath={resolved[c.command]}
            onToggle={(on) => toggle(c.id, on)}
          />
        ))}
      </div>
    </div>
  );
}

function LanguageRow({
  config,
  enabled,
  resolvedPath,
  onToggle,
}: {
  config: LspConfig;
  enabled: boolean;
  resolvedPath: string | null | undefined;
  onToggle: (enabled: boolean) => void;
}) {
  const found = resolvedPath !== null && resolvedPath !== undefined;
  const checking = resolvedPath === undefined;
  const statusColor = !enabled
    ? "bg-neutral-700"
    : checking
      ? "bg-neutral-500"
      : found
        ? "bg-emerald-500"
        : "bg-red-500";
  const statusLabel = !enabled
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
        checked={enabled}
        onChange={(e) => onToggle(e.target.checked)}
        className="mt-0.5 accent-blue-600"
      />
      <span className="flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn("h-2 w-2 rounded-full", statusColor)} />
          <div className="font-medium text-neutral-100">{config.displayName}</div>
        </div>
        <div className="truncate font-mono text-[11px] text-neutral-500">
          {enabled ? statusLabel : `${config.command} ${config.args.join(" ")}`.trim()}
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
      <div className="mb-1.5 text-[11px] uppercase tracking-wider text-neutral-500">
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
