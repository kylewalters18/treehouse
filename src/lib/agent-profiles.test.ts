import { describe, expect, it } from "vitest";
import {
  buildLaunchProfiles,
  resolveDefaultProfile,
  tabLabelBase,
} from "./agent-profiles";

const commands = { claudeCode: "claude", codex: "codex", kiro: "kiro-cli" };

describe("buildLaunchProfiles", () => {
  it("keeps configured order, then backends over ACP, then their TUIs", () => {
    const profiles = buildLaunchProfiles(
      [
        { workspace: "/r", name: "Reviewer", backend: "claudeCode", command: "claude --agent reviewer" },
        { name: "Fast", backend: "codex", command: "codex --model o5" },
      ],
      commands,
    );
    expect(profiles.map((p) => [p.key, p.scope])).toEqual([
      ["repo:Reviewer", "repo"],
      ["global:Fast", "global"],
      ["acp:claudeCode", "default"],
      ["acp:codex", "default"],
      ["acp:kiro", "default"],
      ["default:claudeCode", "terminal"],
      ["default:codex", "terminal"],
      ["default:kiro", "terminal"],
    ]);
    expect(profiles.slice(2, 5).every((p) => p.transport === "acp")).toBe(true);
    expect(profiles.slice(5).every((p) => p.transport === "pty")).toBe(true);
  });
});

describe("tabLabelBase", () => {
  const profiles = buildLaunchProfiles(
    [{ workspace: "/r", name: "Reviewer", backend: "claudeCode", command: `claude --agent "code reviewer"` }],
    commands,
  );

  it("names a session after the profile whose command matches", () => {
    expect(tabLabelBase("claudeCode", ["claude", "--agent", "code reviewer"], profiles)).toBe("Reviewer");
  });

  it("falls back to backend name plus --agent", () => {
    expect(tabLabelBase("claudeCode", ["claude", "--agent", "other"], profiles)).toBe("Claude (other)");
    expect(tabLabelBase("claudeCode", ["claude"], profiles)).toBe("Claude");
    expect(tabLabelBase("codex", undefined, profiles)).toBe("Codex");
  });
});

describe("resolveDefaultProfile", () => {
  const profiles = buildLaunchProfiles(
    [{ workspace: "/r", name: "Reviewer", backend: "claudeCode", command: "claude --agent r" }],
    commands,
  );

  it("prefers the last-used profile", () => {
    expect(resolveDefaultProfile(profiles, "repo:Reviewer", "codex").name).toBe("Reviewer");
  });

  it("falls back to the settings default backend over ACP", () => {
    expect(resolveDefaultProfile(profiles, "repo:Gone", "codex").key).toBe("acp:codex");
    expect(resolveDefaultProfile(profiles, null, "kiro").key).toBe("acp:kiro");
  });

  it("keeps an explicit terminal pick", () => {
    expect(resolveDefaultProfile(profiles, "default:claudeCode", "codex").transport).toBe("pty");
  });
});

describe("ACP profiles", () => {
  const acp = [
    {
      backend: "claudeCode" as const,
      configured: null,
      label: "@agentclientprotocol/claude-agent-acp@0.86.0 (managed)",
      needsInstall: true,
    },
    { backend: "codex" as const, configured: "my-codex-acp", label: "my-codex-acp", needsInstall: false },
    { backend: "kiro" as const, configured: null, label: "kiro-cli acp", needsInstall: false },
  ];

  it("hints each backend's adapter once known", () => {
    const profiles = buildLaunchProfiles([], commands, acp);
    // Launch with an empty command so Rust resolves override vs managed.
    expect(profiles.slice(0, 3).map((p) => p.command)).toEqual(["", "", ""]);
    expect(profiles[0].hint).toBe(
      "@agentclientprotocol/claude-agent-acp@0.86.0 (managed) · installs on first launch",
    );
    expect(profiles[1].hint).toBe("my-codex-acp");
    expect(buildLaunchProfiles([], commands)[0].hint).toBe("ACP adapter");
  });

  it("carries a configured profile's transport and labels ACP tabs", () => {
    const profiles = buildLaunchProfiles(
      [{ name: "Claude ACP", backend: "claudeCode", command: "my-adapter", transport: "acp" }],
      commands,
      acp,
    );
    expect(profiles[0].transport).toBe("acp");
    expect(tabLabelBase("claudeCode", ["my-adapter"], profiles, "acp")).toBe("Claude ACP");
    // Same argv over a PTY doesn't borrow the ACP profile's name.
    expect(tabLabelBase("claudeCode", ["my-adapter"], profiles)).toBe("Claude");
    expect(tabLabelBase("codex", undefined, profiles, "acp")).toBe("Codex");
  });
});
