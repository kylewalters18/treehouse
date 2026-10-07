import type { AcpAdapterInfo, AgentBackendKind, AgentProfile, AgentTransport } from "@/ipc/types";
import { splitCommand } from "./shell-words";

/// A launchable entry in the agent `+ ▾` menu: a `[[agent.profile]]` from
/// `treehouse.toml` (repo-scoped or global), or one of the per-backend
/// defaults whose command comes from Settings.
export type LaunchProfile = {
  /// Stable across reloads — used to remember the last-used profile.
  key: string;
  name: string;
  backend: AgentBackendKind;
  command: string;
  /// `acp` launches through the backend's ACP adapter (`command` is then
  /// the adapter command).
  transport: AgentTransport;
  /// Shown in place of an empty `command`: what Rust will resolve it to.
  hint?: string;
  /// `acp` = the built-in ACP adapter entries (experimental).
  scope: "repo" | "global" | "default" | "acp";
};

export const BACKENDS: AgentBackendKind[] = ["claudeCode", "codex", "kiro"];

export const BACKEND_NAMES: Record<AgentBackendKind, string> = {
  claudeCode: "Claude Code",
  codex: "Codex",
  kiro: "Kiro",
};

/// Short form used as the tab-label base for default launches.
export const BACKEND_TAB_LABELS: Record<AgentBackendKind, string> = {
  claudeCode: "Claude",
  codex: "Codex",
  kiro: "Kiro",
};

/// Menu order: this repo's profiles, then global ones, then the three
/// backend defaults, then the ACP adapters (when known). `configured`
/// arrives from Rust already ordered repo-first.
export function buildLaunchProfiles(
  configured: AgentProfile[],
  agentCommands: Record<AgentBackendKind, string>,
  acpAdapters?: AcpAdapterInfo[] | null,
): LaunchProfile[] {
  const out: LaunchProfile[] = configured.map((p) => ({
    key: `${p.workspace ? "repo" : "global"}:${p.name}`,
    name: p.name,
    backend: p.backend,
    command: p.command,
    transport: p.transport ?? "pty",
    scope: p.workspace ? "repo" : "global",
  }));
  for (const b of BACKENDS) {
    out.push({
      key: `default:${b}`,
      name: BACKEND_NAMES[b],
      backend: b,
      command: agentCommands[b] ?? "",
      transport: "pty",
      scope: "default",
    });
  }
  for (const a of acpAdapters ?? []) {
    out.push({
      key: `acp:${a.backend}`,
      name: `${BACKEND_NAMES[a.backend]} (ACP)`,
      backend: a.backend,
      // Empty → Rust resolves the override / managed install at launch.
      command: "",
      hint: a.needsInstall ? `${a.label} · installs on first launch` : a.label,
      transport: "acp",
      scope: "acp",
    });
  }
  return out;
}

/// argv for a command field; `undefined` (empty field) lets Rust fall back
/// to the backend's built-in command.
export function commandArgv(command: string): string[] | undefined {
  const argv = splitCommand(command);
  return argv.length > 0 ? argv : undefined;
}

/// Tab-label base (before the per-pane counter) for a session. A configured
/// profile whose command matches the argv lends its name, so re-adopted
/// sessions keep their profile label across remounts. Otherwise: the
/// backend's short name plus any `--agent` value.
export function tabLabelBase(
  backend: AgentBackendKind,
  argv: string[] | undefined,
  profiles: LaunchProfile[],
  transport: AgentTransport = "pty",
): string {
  if (argv) {
    const joined = JSON.stringify(argv);
    const match = profiles.find(
      (p) =>
        (p.scope === "repo" || p.scope === "global") &&
        p.backend === backend &&
        p.transport === transport &&
        JSON.stringify(splitCommand(p.command)) === joined,
    );
    if (match) return match.name;
  }
  if (transport === "acp") return `${BACKEND_TAB_LABELS[backend]} ACP`;
  const base = BACKEND_TAB_LABELS[backend];
  const i = argv?.indexOf("--agent") ?? -1;
  return argv && i >= 0 && i + 1 < argv.length ? `${base} (${argv[i + 1]})` : base;
}

/// Flags treehouse appends to every launch of `backend`, shown read-only
/// after the command in the Edit & launch field.
export function injectedTail(
  backend: AgentBackendKind,
  transport: AgentTransport = "pty",
): string {
  if (transport === "acp") return "(ACP · MCP via session/new)";
  return backend === "claudeCode" ? "--mcp-config <treehouse>" : "";
}

const LAST_USED_KEY = "treehouse.lastAgentProfile";

/// Last-launched profile key per repo root. Per-viewer convenience, so
/// localStorage (not settings.json) is fine; failures read as "none".
export function getLastProfileKey(workspaceRoot: string): string | null {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_USED_KEY) ?? "{}");
    return typeof all[workspaceRoot] === "string" ? all[workspaceRoot] : null;
  } catch {
    return null;
  }
}

export function setLastProfileKey(workspaceRoot: string, key: string) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_USED_KEY) ?? "{}");
    all[workspaceRoot] = key;
    localStorage.setItem(LAST_USED_KEY, JSON.stringify(all));
  } catch {}
}

/// Which profile `+` / ⌘⇧A launches: the repo's last-used one if it still
/// exists, else the Settings default backend.
export function resolveDefaultProfile(
  profiles: LaunchProfile[],
  lastKey: string | null,
  defaultBackend: AgentBackendKind,
): LaunchProfile {
  return (
    profiles.find((p) => p.key === lastKey) ??
    profiles.find((p) => p.key === `default:${defaultBackend}`) ??
    profiles[profiles.length - 1]
  );
}
