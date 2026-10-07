import { describe, expect, it } from "vitest";
import {
  buildLaunchProfiles,
  resolveDefaultProfile,
  tabLabelBase,
} from "./agent-profiles";

const commands = { claudeCode: "claude", codex: "codex", kiro: "kiro-cli" };

describe("buildLaunchProfiles", () => {
  it("keeps configured order and appends backend defaults", () => {
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
      ["default:claudeCode", "default"],
      ["default:codex", "default"],
      ["default:kiro", "default"],
    ]);
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

  it("falls back to the settings default backend when last-used is gone", () => {
    expect(resolveDefaultProfile(profiles, "repo:Gone", "codex").key).toBe("default:codex");
    expect(resolveDefaultProfile(profiles, null, "kiro").key).toBe("default:kiro");
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

  it("appends an ACP entry per backend after the defaults", () => {
    const profiles = buildLaunchProfiles([], commands, acp);
    expect(profiles.slice(3).map((p) => [p.key, p.scope, p.transport])).toEqual([
      ["acp:claudeCode", "acp", "acp"],
      ["acp:codex", "acp", "acp"],
      ["acp:kiro", "acp", "acp"],
    ]);
    // Launch with an empty command so Rust resolves override vs managed.
    expect(profiles.slice(3).map((p) => p.command)).toEqual(["", "", ""]);
    expect(profiles[3].hint).toBe(
      "@agentclientprotocol/claude-agent-acp@0.86.0 (managed) · installs on first launch",
    );
    expect(profiles[4].hint).toBe("my-codex-acp");
    expect(profiles[0].transport).toBe("pty");
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
    expect(tabLabelBase("codex", ["npx", "x"], profiles, "acp")).toBe("Codex ACP");
  });
});
