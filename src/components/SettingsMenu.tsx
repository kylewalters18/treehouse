import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSettingsStore } from "@/stores/settings";
import { useLspStore } from "@/stores/lsp";
import { useForgeStore } from "@/stores/forge";
import { useUiStore } from "@/stores/ui";
import { useWorktreesStore } from "@/stores/worktrees";
import { useWorkspaceStore, workspaceForWorktree } from "@/stores/workspace";
import { useTreehouseConfigStore } from "@/stores/treehouseConfig";
import type {
  AgentBackendKind,
  LspConfig,
  LspOverride,
  MergeBackStrategy,
  SyncStrategy,
  WorktreeHookEntry,
} from "@/ipc/types";
import { cn } from "@/lib/cn";
import { asMessage } from "@/lib/errors";
import { toastError, toastSuccess } from "@/stores/toasts";

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

type Category =
  | "workflow"
  | "agents"
  | "languages"
  | "hooks"
  | "forge"
  | "keybindings";
const CATEGORIES: { id: Category; label: string }[] = [
  { id: "workflow", label: "Workflow" },
  { id: "agents", label: "Agents" },
  { id: "languages", label: "Languages" },
  { id: "hooks", label: "Hooks" },
  { id: "forge", label: "Forge" },
  { id: "keybindings", label: "Keybindings" },
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
                <div className="flex flex-col gap-5">
                  <Section
                    label="Default agent"
                    options={AGENT_OPTIONS}
                    value={settings.defaultAgentBackend}
                    onChange={(v) => void setDefaultAgent(v)}
                  />
                  <AgentPatternsSection />
                </div>
              )}

              {active === "languages" && <LanguagesPane />}
              {active === "hooks" && <HooksPane />}
              {active === "forge" && <ForgePane />}
              {active === "keybindings" && <KeybindingsPane />}
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

/// A single keyboard chord rendered as <kbd> caps. Each token is one
/// cap; a token may itself be a glyph (⌘) or a label ("1 – 9", "Enter").
function Kbd({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono text-[11px] leading-none text-neutral-200 shadow-[0_1px_0_rgb(0_0_0/0.5)]"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

/// One reference row: a list of chords (joined by "/") and a label.
type Binding = { combos: string[][]; label: string };

const KEYBINDING_GROUPS: { group: string; items: Binding[] }[] = [
  {
    group: "Create",
    items: [
      { combos: [["⌘", "T"]], label: "New terminal tab" },
      { combos: [["⌘", "⇧", "A"]], label: "New agent tab" },
      { combos: [["⌘", "⇧", "N"]], label: "New worktree" },
    ],
  },
  {
    group: "View & navigation",
    items: [
      { combos: [["⌘", "B"]], label: "Toggle worktree sidebar" },
      { combos: [["⌘", "\\"]], label: "Toggle focus mode" },
      { combos: [["⌘", "⇧", "M"]], label: "Toggle Problems / Terminal" },
      { combos: [["⌘", "P"]], label: "Go to file" },
      { combos: [["⌘", "⇧", "P"]], label: "Command palette" },
      { combos: [["⌘", "["]], label: "Navigate back (cursor history)" },
      { combos: [["⌘", "]"]], label: "Navigate forward (cursor history)" },
    ],
  },
  {
    group: "Editor",
    items: [{ combos: [["⌘", "S"]], label: "Save file" }],
  },
  {
    group: "Terminal",
    items: [
      { combos: [["⌘", "F"]], label: "Find in terminal" },
      { combos: [["Enter"]], label: "Find next match (terminal search)" },
      { combos: [["⇧", "Enter"]], label: "Find previous match (terminal search)" },
      { combos: [["⇧", "Enter"]], label: "Agent input: newline without sending" },
    ],
  },
  {
    group: "Review comments",
    items: [
      { combos: [["⌘", "Enter"]], label: "Save / post comment" },
      { combos: [["⌘", "⇧", "Enter"]], label: "Save comment and send to agent" },
    ],
  },
  {
    group: "Dialogs & pickers",
    items: [
      { combos: [["Esc"]], label: "Close dialog / menu" },
      { combos: [["↑"], ["↓"]], label: "Move selection" },
      { combos: [["Enter"]], label: "Confirm selection" },
    ],
  },
];

/// Read-only reference of every keyboard shortcut. Remapping is a
/// follow-up — for now this documents what's wired up. macOS glyphs:
/// ⌘ Command · ⇧ Shift · ⌃ Control · ⌥ Option.
function KeybindingsPane() {
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wider text-neutral-500">
        Keybindings
      </div>
      <p className="mb-3 text-[11px] text-neutral-600">
        Read-only for now — custom remapping is coming. Glyphs:{" "}
        <span className="font-mono">⌘</span> Command,{" "}
        <span className="font-mono">⇧</span> Shift,{" "}
        <span className="font-mono">⌃</span> Control,{" "}
        <span className="font-mono">⌥</span> Option.
      </p>
      <div className="flex flex-col gap-4">
        {KEYBINDING_GROUPS.map((g) => (
          <div key={g.group}>
            <div className="mb-1.5 text-[11px] uppercase tracking-wider text-neutral-500">
              {g.group}
            </div>
            <div className="flex flex-col divide-y divide-neutral-800/60 rounded border border-neutral-800">
              {g.items.map((b, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-3 px-2.5 py-1.5"
                >
                  <span className="text-xs text-neutral-200">{b.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {b.combos.map((combo, ci) => (
                      <span key={ci} className="flex items-center gap-1">
                        {ci > 0 && (
                          <span className="text-[11px] text-neutral-600">/</span>
                        )}
                        <Kbd keys={combo} />
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/// Form-string view of an `LspConfig`'s editable fields. Array/map
/// fields are edited as newline-delimited text (one entry per line;
/// env as `KEY=VALUE`) and parsed back on save.
type LangDraft = {
  displayName: string;
  command: string;
  args: string;
  filetypes: string;
  rootMarkers: string;
  env: string;
};

const EMPTY_DRAFT: LangDraft = {
  displayName: "",
  command: "",
  args: "",
  filetypes: "",
  rootMarkers: "",
  env: "",
};

function toDraft(c: LspConfig): LangDraft {
  return {
    displayName: c.displayName,
    command: c.command,
    args: c.args.join("\n"),
    filetypes: c.filetypes.join("\n"),
    rootMarkers: c.rootMarkers.join("\n"),
    env: Object.entries(c.env)
      .map(([k, v]) => `${k}=${v ?? ""}`)
      .join("\n"),
  };
}

function splitLines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function parseEnv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of splitLines(s)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/// Assemble an `LspConfig` from the form. `base` (the config being
/// edited, if any) carries through fields we don't expose in the UI —
/// `installHint` and `pathMapping` — so editing a built-in's command
/// doesn't silently drop its container path mapping.
function fromDraft(
  id: string,
  base: LspConfig | null,
  d: LangDraft,
): LspConfig {
  return {
    id,
    displayName: d.displayName.trim() || id,
    command: d.command.trim(),
    args: splitLines(d.args),
    filetypes: splitLines(d.filetypes),
    rootMarkers: splitLines(d.rootMarkers),
    installHint: base?.installHint ?? null,
    env: parseEnv(d.env),
    pathMapping: base?.pathMapping ?? null,
  };
}

function LanguagesPane() {
  const configs = useLspStore((s) => s.configs);
  const resolved = useLspStore((s) => s.resolved);
  const load = useLspStore((s) => s.load);
  const builtinIds = useLspStore((s) => s.builtinIds);
  const customizedIds = useLspStore((s) => s.customizedIds);
  const settings = useSettingsStore((s) => s.settings);
  const setEnabledLanguages = useSettingsStore((s) => s.setEnabledLspLanguages);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (configs.length === 0) void load();
  }, [configs.length, load]);

  const enabledSet = useMemo(
    () => new Set(settings.enabledLspLanguages),
    [settings.enabledLspLanguages],
  );
  const builtinSet = useMemo(() => new Set(builtinIds), [builtinIds]);
  const customizedSet = useMemo(() => new Set(customizedIds), [customizedIds]);
  const existingIds = useMemo(
    () => new Set(configs.map((c) => c.id)),
    [configs],
  );

  function toggle(id: string, on: boolean) {
    const next = new Set(enabledSet);
    if (on) next.add(id);
    else next.delete(id);
    void setEnabledLanguages([...next].sort());
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-neutral-500">
          Languages (LSP)
        </div>
        <button
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? "Cancel" : "+ Add custom"}
        </button>
      </div>
      <p className="mb-2 text-[11px] text-neutral-600">
        Edits are saved to <code className="font-mono">treehouse.toml</code> and
        restart that language's servers. Editing a built-in overrides its
        defaults; Reset restores them.
      </p>
      {adding && (
        <div className="mb-2 rounded border border-neutral-700 px-2 py-2">
          <LanguageEditor
            mode="add"
            existingIds={existingIds}
            onDone={(id) => {
              setAdding(false);
              if (id) toggle(id, true);
            }}
          />
        </div>
      )}
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
            isBuiltin={builtinSet.has(c.id)}
            isCustomized={customizedSet.has(c.id)}
            onToggle={(on) => toggle(c.id, on)}
          />
        ))}
      </div>
      <LspOverridesSection />
    </div>
  );
}

/// Helpers shared by the override/hook editors: arrays render as
/// one-per-line textareas, env as `KEY=VALUE` lines.
function envToText(env: { [key in string]?: string } | null | undefined): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v ?? ""}`)
    .join("\n");
}

/// Per-workspace `[[lsp.override]]` editing. Whole-list replace on
/// save — there's no stable per-entry key, and overrides are keyed by
/// (workspace, language). Edits land in `treehouse.toml` and apply on
/// the next file open / "Restart language servers".
function LspOverridesSection() {
  const overrides = useTreehouseConfigStore((s) => s.overrides);
  const loaded = useTreehouseConfigStore((s) => s.loaded);
  const load = useTreehouseConfigStore((s) => s.load);
  const save = useTreehouseConfigStore((s) => s.saveOverrides);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const [draft, setDraft] = useState<LspOverride[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  // Sync the local draft from the store once it loads / changes under us.
  useEffect(() => {
    if (loaded) setDraft(overrides);
  }, [loaded, overrides]);

  if (draft === null) {
    return (
      <div className="mt-5 text-[11px] text-neutral-500">Loading overrides…</div>
    );
  }

  function patch(i: number, p: Partial<LspOverride>) {
    setDraft((d) => d!.map((o, idx) => (idx === i ? { ...o, ...p } : o)));
  }
  function add() {
    setDraft((d) => [
      ...d!,
      {
        workspace: workspaces[0]?.root ?? "",
        language: "",
        command: null,
        args: null,
        env: null,
        pathMapping: null,
      },
    ]);
  }
  function remove(i: number) {
    setDraft((d) => d!.filter((_, idx) => idx !== i));
  }
  async function commit() {
    setBusy(true);
    try {
      const cleaned = draft!
        .filter((o) => o.workspace.trim() && o.language.trim())
        .map((o) => ({ ...o, workspace: o.workspace.trim(), language: o.language.trim() }));
      await save(cleaned);
      toastSuccess("Saved LSP overrides");
    } catch (e) {
      toastError("Failed to save overrides", asMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(overrides);

  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-neutral-500">
          LSP overrides (per workspace)
        </div>
        <button
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
          onClick={add}
        >
          + Add override
        </button>
      </div>
      <p className="mb-2 text-[11px] text-neutral-600">
        Run a language's server differently for one repo (e.g. clangd inside a
        devcontainer). Empty fields inherit from the language's defaults.
        Applies on the next file open or “Restart language servers”.
      </p>
      <WorkspaceDatalist id="override-ws-list" />
      <div className="flex flex-col gap-2">
        {draft.length === 0 && (
          <div className="rounded border border-dashed border-neutral-800 px-2 py-3 text-center text-[11px] text-neutral-600">
            No overrides.
          </div>
        )}
        {draft.map((o, i) => (
          <div key={i} className="rounded border border-neutral-800 px-2 py-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] text-neutral-500">Override {i + 1}</span>
              <button
                className="text-[11px] text-red-400 hover:text-red-300"
                onClick={() => remove(i)}
                title="Remove"
              >
                Remove
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <LangField label="Workspace (repo path)">
                <input
                  className={FIELD_CLS}
                  list="override-ws-list"
                  value={o.workspace}
                  onChange={(e) => patch(i, { workspace: e.target.value })}
                  placeholder="/Users/you/Code/repo"
                />
              </LangField>
              <LangField label="Language id" hint="e.g. cpp, rust">
                <input
                  className={FIELD_CLS}
                  value={o.language}
                  onChange={(e) => patch(i, { language: e.target.value })}
                  placeholder="cpp"
                />
              </LangField>
            </div>
            <div className="mt-2">
              <LangField label="Command" hint="blank = inherit">
                <input
                  className={FIELD_CLS}
                  value={o.command ?? ""}
                  onChange={(e) =>
                    patch(i, { command: e.target.value.trim() || null })
                  }
                  placeholder="docker"
                />
              </LangField>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <LangField label="Args" hint="one per line; blank = inherit">
                <textarea
                  className={cn(FIELD_CLS, "h-16 resize-y")}
                  value={(o.args ?? []).join("\n")}
                  onChange={(e) => {
                    const lines = splitLines(e.target.value);
                    patch(i, { args: lines.length ? lines : null });
                  }}
                  placeholder={"exec\n-i\nclangd-${WORKTREE_NAME}\nclangd"}
                />
              </LangField>
              <LangField label="Env" hint="KEY=VALUE; blank = inherit">
                <textarea
                  className={cn(FIELD_CLS, "h-16 resize-y")}
                  value={envToText(o.env)}
                  onChange={(e) => {
                    const env = parseEnv(e.target.value);
                    patch(i, {
                      env: Object.keys(env).length ? env : null,
                    });
                  }}
                  placeholder={"RUST_LOG=info"}
                />
              </LangField>
            </div>
            <div className="mt-2">
              <LangField
                label="Remote root (path mapping)"
                hint="container path; blank = none"
              >
                <input
                  className={FIELD_CLS}
                  value={o.pathMapping?.remoteRoot ?? ""}
                  onChange={(e) => {
                    const remoteRoot = e.target.value.trim();
                    patch(i, {
                      pathMapping: remoteRoot
                        ? { remoteRoot, hostRoot: o.pathMapping?.hostRoot ?? null }
                        : null,
                    });
                  }}
                  placeholder="/workspaces/repo"
                />
              </LangField>
            </div>
          </div>
        ))}
      </div>
      {dirty && (
        <div className="mt-2 flex items-center gap-2">
          <button
            disabled={busy}
            onClick={() => void commit()}
            className="rounded bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Save overrides
          </button>
          <button
            disabled={busy}
            onClick={() => setDraft(overrides)}
            className="rounded border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

/// `<datalist>` of open repo roots, so workspace-path fields autofill
/// from the repos you have open instead of hand-typed absolute paths.
function WorkspaceDatalist({ id }: { id: string }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  return (
    <datalist id={id}>
      {workspaces.map((w) => (
        <option key={w.id} value={w.root} />
      ))}
    </datalist>
  );
}

function LanguageRow({
  config,
  enabled,
  resolvedPath,
  isBuiltin,
  isCustomized,
  onToggle,
}: {
  config: LspConfig;
  enabled: boolean;
  resolvedPath: string | null | undefined;
  isBuiltin: boolean;
  isCustomized: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
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
    <div className="rounded border border-neutral-800">
      <div className="flex items-start gap-2 px-2 py-1.5 text-xs">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-0.5 accent-blue-600"
          title={statusLabel}
        />
        <button
          type="button"
          className="flex flex-1 items-start gap-1.5 text-left hover:opacity-90"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="mt-0.5 w-2 text-neutral-500">{open ? "▾" : "▸"}</span>
          <span className="flex-1 overflow-hidden">
            <span className="flex items-center gap-1.5">
              <span className={cn("h-2 w-2 rounded-full", statusColor)} />
              <span className="font-medium text-neutral-100">
                {config.displayName}
              </span>
              {isCustomized && (
                <span className="rounded bg-neutral-800 px-1 text-[10px] text-neutral-400">
                  {isBuiltin ? "customized" : "custom"}
                </span>
              )}
            </span>
            <span className="block truncate font-mono text-[11px] text-neutral-500">
              {enabled
                ? statusLabel
                : `${config.command} ${config.args.join(" ")}`.trim()}
            </span>
          </span>
        </button>
      </div>
      {open && (
        <div className="border-t border-neutral-800 px-2 py-2">
          <LanguageEditor
            mode="edit"
            config={config}
            isBuiltin={isBuiltin}
            isCustomized={isCustomized}
            onDone={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

function LangField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 flex items-baseline gap-1.5">
        <span className="text-[11px] text-neutral-400">{label}</span>
        {hint && <span className="text-[10px] text-neutral-600">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

const FIELD_CLS =
  "w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-[11px] text-neutral-200 focus:border-blue-600 focus:outline-none";

function LanguageEditor({
  mode,
  config,
  isBuiltin,
  isCustomized,
  existingIds,
  onDone,
}: {
  mode: "add" | "edit";
  config?: LspConfig;
  isBuiltin?: boolean;
  isCustomized?: boolean;
  existingIds?: Set<string>;
  onDone: (savedId?: string) => void;
}) {
  const upsert = useLspStore((s) => s.upsertLanguage);
  const reset = useLspStore((s) => s.resetLanguage);
  const [id, setId] = useState(config?.id ?? "");
  const [draft, setDraft] = useState<LangDraft>(() =>
    config ? toDraft(config) : EMPTY_DRAFT,
  );
  const [busy, setBusy] = useState(false);

  function patch(p: Partial<LangDraft>) {
    setDraft((d) => ({ ...d, ...p }));
  }

  async function save() {
    const effectiveId = (mode === "add" ? id : config!.id).trim();
    if (!effectiveId) {
      toastError("Language id is required");
      return;
    }
    if (mode === "add" && existingIds?.has(effectiveId)) {
      toastError(`Language "${effectiveId}" already exists`);
      return;
    }
    if (!draft.command.trim()) {
      toastError("Command is required");
      return;
    }
    setBusy(true);
    try {
      await upsert(fromDraft(effectiveId, config ?? null, draft));
      toastSuccess(
        mode === "add"
          ? `Added language "${effectiveId}"`
          : `Saved "${effectiveId}"`,
      );
      onDone(mode === "add" ? effectiveId : undefined);
    } catch (e) {
      toastError("Failed to save language", asMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function doReset() {
    if (!config) return;
    setBusy(true);
    try {
      await reset(config.id);
      toastSuccess(
        isBuiltin ? `Reset "${config.id}" to default` : `Deleted "${config.id}"`,
      );
      onDone();
    } catch (e) {
      toastError("Failed to reset language", asMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {mode === "add" ? (
        <div className="grid grid-cols-2 gap-2">
          <LangField label="ID" hint="slug, e.g. haskell">
            <input
              className={FIELD_CLS}
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="haskell"
            />
          </LangField>
          <LangField label="Display name">
            <input
              className={FIELD_CLS}
              value={draft.displayName}
              onChange={(e) => patch({ displayName: e.target.value })}
              placeholder="Haskell (HLS)"
            />
          </LangField>
        </div>
      ) : (
        <LangField label="Display name">
          <input
            className={FIELD_CLS}
            value={draft.displayName}
            onChange={(e) => patch({ displayName: e.target.value })}
          />
        </LangField>
      )}

      <LangField label="Command" hint="binary name or absolute path">
        <input
          className={FIELD_CLS}
          value={draft.command}
          onChange={(e) => patch({ command: e.target.value })}
          placeholder="haskell-language-server-wrapper"
        />
      </LangField>

      <div className="grid grid-cols-2 gap-2">
        <LangField label="Args" hint="one per line">
          <textarea
            className={cn(FIELD_CLS, "h-16 resize-y")}
            value={draft.args}
            onChange={(e) => patch({ args: e.target.value })}
            placeholder={"--lsp"}
          />
        </LangField>
        <LangField label="Filetypes" hint="Monaco language ids, one per line">
          <textarea
            className={cn(FIELD_CLS, "h-16 resize-y")}
            value={draft.filetypes}
            onChange={(e) => patch({ filetypes: e.target.value })}
            placeholder={"haskell"}
          />
        </LangField>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <LangField label="Root markers" hint="one per line">
          <textarea
            className={cn(FIELD_CLS, "h-16 resize-y")}
            value={draft.rootMarkers}
            onChange={(e) => patch({ rootMarkers: e.target.value })}
            placeholder={"stack.yaml\ncabal.project"}
          />
        </LangField>
        <LangField label="Env" hint="KEY=VALUE, one per line">
          <textarea
            className={cn(FIELD_CLS, "h-16 resize-y")}
            value={draft.env}
            onChange={(e) => patch({ env: e.target.value })}
            placeholder={"RUST_LOG=info"}
          />
        </LangField>
      </div>

      {config?.pathMapping && (
        <p className="text-[10px] text-neutral-600">
          A container path mapping is configured for this language in
          treehouse.toml and is preserved across edits here.
        </p>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {mode === "add" ? "Add" : "Save"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDone()}
          className="rounded border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          Cancel
        </button>
        {mode === "edit" && (isCustomized || !isBuiltin) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void doReset()}
            className="ml-auto rounded border border-red-900 px-2.5 py-1 text-[11px] text-red-400 hover:bg-red-950 disabled:opacity-50"
          >
            {isBuiltin ? "Reset to default" : "Delete"}
          </button>
        )}
      </div>
    </div>
  );
}

const PATTERN_BACKENDS: { key: AgentBackendKind; label: string; note?: string }[] =
  [
    {
      key: "claudeCode",
      label: "Claude Code",
      note: "Status comes from Claude's hooks API; these patterns are only a fallback for dropped hooks (off by default).",
    },
    { key: "kiro", label: "Kiro" },
    { key: "codex", label: "Codex" },
  ];

/// Per-backend agent status patterns. Substrings scanned on PTY output
/// to flag "needs attention" / "idle". Shows the effective set
/// (built-in defaults when uncustomized); per-backend Reset drops the
/// customization so defaults re-apply.
function AgentPatternsSection() {
  const patterns = useTreehouseConfigStore((s) => s.patterns);
  const customized = useTreehouseConfigStore((s) => s.customizedBackends);
  const loaded = useTreehouseConfigStore((s) => s.loaded);
  const load = useTreehouseConfigStore((s) => s.load);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  return (
    <div>
      <div className="mb-1.5 text-[11px] uppercase tracking-wider text-neutral-500">
        Status patterns
      </div>
      <p className="mb-2 text-[11px] text-neutral-600">
        Substrings matched on each agent's output to flag when it needs you or
        has gone idle. Changes apply to running agents immediately.
      </p>
      {!patterns ? (
        <div className="text-[11px] text-neutral-500">Loading…</div>
      ) : (
        <div className="flex flex-col gap-1">
          {PATTERN_BACKENDS.map((b) => (
            <BackendPatternRow
              key={b.key}
              backend={b.key}
              label={b.label}
              note={b.note}
              attention={patterns[b.key].attention}
              idle={patterns[b.key].idle}
              customized={customized.includes(b.key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BackendPatternRow({
  backend,
  label,
  note,
  attention,
  idle,
  customized,
}: {
  backend: AgentBackendKind;
  label: string;
  note?: string;
  attention: string[];
  idle: string[];
  customized: boolean;
}) {
  const save = useTreehouseConfigStore((s) => s.saveBackendPatterns);
  const reset = useTreehouseConfigStore((s) => s.resetBackend);
  const [open, setOpen] = useState(false);
  const [att, setAtt] = useState(attention.join("\n"));
  const [idl, setIdl] = useState(idle.join("\n"));
  const [busy, setBusy] = useState(false);

  // Re-sync local drafts whenever the store's effective patterns change
  // (after a save or reset elsewhere).
  useEffect(() => {
    setAtt(attention.join("\n"));
    setIdl(idle.join("\n"));
  }, [attention, idle]);

  const dirty =
    att !== attention.join("\n") || idl !== idle.join("\n");

  async function doSave() {
    setBusy(true);
    try {
      await save(backend, { attention: splitLines(att), idle: splitLines(idl) });
      toastSuccess(`Saved ${label} patterns`);
    } catch (e) {
      toastError("Failed to save patterns", asMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function doReset() {
    setBusy(true);
    try {
      await reset(backend);
      toastSuccess(`Reset ${label} patterns to defaults`);
    } catch (e) {
      toastError("Failed to reset patterns", asMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-neutral-800">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs hover:opacity-90"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="w-2 text-neutral-500">{open ? "▾" : "▸"}</span>
        <span className="font-medium text-neutral-100">{label}</span>
        {customized && (
          <span className="rounded bg-neutral-800 px-1 text-[10px] text-neutral-400">
            customized
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-neutral-500">
          {attention.length} attn · {idle.length} idle
        </span>
      </button>
      {open && (
        <div className="border-t border-neutral-800 px-2 py-2">
          {note && (
            <p className="mb-2 text-[10px] text-neutral-600">{note}</p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <LangField label="Attention" hint="one substring per line">
              <textarea
                className={cn(FIELD_CLS, "h-20 resize-y")}
                value={att}
                onChange={(e) => setAtt(e.target.value)}
                placeholder={"requires approval\n[y/N]"}
              />
            </LangField>
            <LangField label="Idle" hint="one substring per line">
              <textarea
                className={cn(FIELD_CLS, "h-20 resize-y")}
                value={idl}
                onChange={(e) => setIdl(e.target.value)}
                placeholder={"ask a question or describe a task"}
              />
            </LangField>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !dirty}
              onClick={() => void doSave()}
              className="rounded bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              Save
            </button>
            {customized && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void doReset()}
                className="ml-auto rounded border border-red-900 px-2.5 py-1 text-[11px] text-red-400 hover:bg-red-950 disabled:opacity-50"
              >
                Reset to default
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/// Form-string view of a worktree hook. `phase` carries which array
/// (`onCreate` / `onDestroy`) the entry belongs to.
type HookDraft = {
  phase: "onCreate" | "onDestroy";
  workspace: string;
  name: string;
  command: string;
  args: string;
  env: string;
};

function toHookDrafts(
  entries: WorktreeHookEntry[],
  phase: "onCreate" | "onDestroy",
): HookDraft[] {
  return entries.map((h) => ({
    phase,
    workspace: h.workspace,
    name: h.name,
    command: h.command,
    args: h.args.join("\n"),
    env: envToText(h.env),
  }));
}

function fromHookDraft(d: HookDraft): WorktreeHookEntry {
  return {
    workspace: d.workspace.trim(),
    name: d.name.trim(),
    command: d.command.trim(),
    args: splitLines(d.args),
    env: parseEnv(d.env),
  };
}

/// User-level worktree lifecycle hooks across all repos, grouped by
/// repo path. Each entry runs for every worktree created/destroyed in
/// its repo. Whole-list replace on save (hooks have no stable key).
function HooksPane() {
  const onCreate = useTreehouseConfigStore((s) => s.onCreate);
  const onDestroy = useTreehouseConfigStore((s) => s.onDestroy);
  const loaded = useTreehouseConfigStore((s) => s.loaded);
  const load = useTreehouseConfigStore((s) => s.load);
  const save = useTreehouseConfigStore((s) => s.saveHooks);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const [draft, setDraft] = useState<HookDraft[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  // Rebuild the local draft from the store, grouped by repo so
  // same-repo hooks cluster under one header.
  useEffect(() => {
    if (!loaded) return;
    const all = [
      ...toHookDrafts(onCreate, "onCreate"),
      ...toHookDrafts(onDestroy, "onDestroy"),
    ].sort((a, b) => a.workspace.localeCompare(b.workspace));
    setDraft(all);
  }, [loaded, onCreate, onDestroy]);

  if (draft === null) {
    return <div className="text-[11px] text-neutral-500">Loading hooks…</div>;
  }

  function patch(i: number, p: Partial<HookDraft>) {
    setDraft((d) => d!.map((h, idx) => (idx === i ? { ...h, ...p } : h)));
  }
  function add() {
    setDraft((d) => [
      ...d!,
      {
        phase: "onCreate",
        workspace: workspaces[0]?.root ?? "",
        name: "",
        command: "",
        args: "",
        env: "",
      },
    ]);
  }
  function remove(i: number) {
    setDraft((d) => d!.filter((_, idx) => idx !== i));
  }
  async function commit() {
    setBusy(true);
    try {
      // Drop incomplete rows (need at least a repo + command), then
      // split back into the two phase arrays.
      const complete = draft!.filter((d) => d.workspace.trim() && d.command.trim());
      const create = complete
        .filter((d) => d.phase === "onCreate")
        .map(fromHookDraft);
      const destroy = complete
        .filter((d) => d.phase === "onDestroy")
        .map(fromHookDraft);
      await save(create, destroy);
      toastSuccess("Saved worktree hooks");
    } catch (e) {
      toastError("Failed to save hooks", asMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // Dirty check against the store's current grouped representation.
  const stored = [
    ...toHookDrafts(onCreate, "onCreate"),
    ...toHookDrafts(onDestroy, "onDestroy"),
  ].sort((a, b) => a.workspace.localeCompare(b.workspace));
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-neutral-500">
          Worktree hooks
        </div>
        <button
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
          onClick={add}
        >
          + Add hook
        </button>
      </div>
      <p className="mb-2 text-[11px] text-neutral-600">
        Commands run when a worktree is created or destroyed, scoped to one
        repo. Templates <code className="font-mono">${"{WORKTREE_PATH}"}</code>,{" "}
        <code className="font-mono">${"{WORKTREE_NAME}"}</code>,{" "}
        <code className="font-mono">${"{BASE_BRANCH}"}</code> expand per worktree.
      </p>
      <WorkspaceDatalist id="hook-ws-list" />
      <div className="flex flex-col gap-2">
        {draft.length === 0 && (
          <div className="rounded border border-dashed border-neutral-800 px-2 py-3 text-center text-[11px] text-neutral-600">
            No hooks.
          </div>
        )}
        {draft.map((h, i) => {
          const showHeader = i === 0 || draft[i - 1].workspace !== h.workspace;
          return (
            <div key={i}>
              {showHeader && (
                <div className="mb-1 mt-1 truncate font-mono text-[10px] text-neutral-500">
                  {h.workspace || "(no repo set)"}
                </div>
              )}
              <div className="rounded border border-neutral-800 px-2 py-2">
                <div className="mb-1 flex items-center gap-2">
                  <select
                    className={cn(FIELD_CLS, "w-auto py-0.5")}
                    value={h.phase}
                    onChange={(e) =>
                      patch(i, {
                        phase: e.target.value as "onCreate" | "onDestroy",
                      })
                    }
                  >
                    <option value="onCreate">On create</option>
                    <option value="onDestroy">On destroy</option>
                  </select>
                  <button
                    className="ml-auto text-[11px] text-red-400 hover:text-red-300"
                    onClick={() => remove(i)}
                  >
                    Remove
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <LangField label="Repo path">
                    <input
                      className={FIELD_CLS}
                      list="hook-ws-list"
                      value={h.workspace}
                      onChange={(e) => patch(i, { workspace: e.target.value })}
                      placeholder="/Users/you/Code/repo"
                    />
                  </LangField>
                  <LangField label="Name" hint="label for this step">
                    <input
                      className={FIELD_CLS}
                      value={h.name}
                      onChange={(e) => patch(i, { name: e.target.value })}
                      placeholder="Bring up devcontainer"
                    />
                  </LangField>
                </div>
                <div className="mt-2">
                  <LangField label="Command">
                    <input
                      className={FIELD_CLS}
                      value={h.command}
                      onChange={(e) => patch(i, { command: e.target.value })}
                      placeholder="devcontainer"
                    />
                  </LangField>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <LangField label="Args" hint="one per line">
                    <textarea
                      className={cn(FIELD_CLS, "h-16 resize-y")}
                      value={h.args}
                      onChange={(e) => patch(i, { args: e.target.value })}
                      placeholder={"up\n--workspace-folder\n${WORKTREE_PATH}"}
                    />
                  </LangField>
                  <LangField label="Env" hint="KEY=VALUE, one per line">
                    <textarea
                      className={cn(FIELD_CLS, "h-16 resize-y")}
                      value={h.env}
                      onChange={(e) => patch(i, { env: e.target.value })}
                    />
                  </LangField>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {dirty && (
        <div className="mt-2 flex items-center gap-2">
          <button
            disabled={busy}
            onClick={() => void commit()}
            className="rounded bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Save hooks
          </button>
          <button
            disabled={busy}
            onClick={() => setDraft(stored)}
            className="rounded border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            Discard
          </button>
        </div>
      )}
    </div>
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
