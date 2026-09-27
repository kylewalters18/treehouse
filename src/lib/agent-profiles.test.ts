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
