import { describe, expect, it } from "vitest";
import type { AcpConfigOption } from "@/ipc/types";
import { composerControls, currentLabel, planToggleTarget } from "./acp-composer";

const opt = (
  id: string,
  category: string | null,
  current: string,
  values: [string, string][],
): AcpConfigOption => ({
  id,
  name: id,
  description: null,
  category,
  current,
  options: values.map(([value, name]) => ({ value, name, description: null })),
});

// The Claude adapter's options, trimmed.
const CLAUDE = [
  opt("mode", "mode", "auto", [
    ["default", "Manual"],
    ["plan", "Plan"],
    ["auto", "Auto"],
    ["bypassPermissions", "Bypass permissions"],
  ]),
  opt("model", "model", "opus", [
    ["opus", "Opus 5.5"],
    ["haiku", "Haiku 4.5"],
  ]),
  opt("effort", "thought_level", "medium", [
    ["low", "Low"],
    ["medium", "Medium"],
  ]),
  opt("fast", "model_config", "off", [
    ["on", "On"],
    ["off", "Off"],
  ]),
];

describe("composerControls", () => {
  it("slots the Claude adapter's options", () => {
    const c = composerControls(CLAUDE, null);
    expect(c.model?.option.id).toBe("model");
    expect(c.effort?.option.id).toBe("effort");
    expect(c.mode?.via).toBe("config");
    expect(c.fast?.on).toBe(false);
    expect(c.plan).toEqual({ active: false });
    expect(c.extra).toEqual([]);
    expect(currentLabel(c.model!.option)).toBe("Opus 5.5");
  });

  it("falls back to the mode list and keeps unknown selects", () => {
    const c = composerControls([opt("sandbox", null, "ro", [["ro", "Read-only"], ["rw", "Write"]])], {
      current: "plan",
      available: [
        { id: "default", name: "Manual", description: null },
        { id: "plan", name: "Plan", description: null },
      ],
    });
    expect(c.mode?.via).toBe("mode");
    expect(c.plan).toEqual({ active: true });
    expect(c.extra.map((p) => p.option.id)).toEqual(["sandbox"]);
    expect(c.model).toBeUndefined();
  });
});

describe("planToggleTarget", () => {
  const mode = CLAUDE[0];
  it("turns plan on, then back to the previous mode", () => {
    expect(planToggleTarget(mode, null)).toBe("plan");
    const inPlan = { ...mode, current: "plan" };
    expect(planToggleTarget(inPlan, "auto")).toBe("auto");
    expect(planToggleTarget(inPlan, null)).toBe("default");
    expect(planToggleTarget(inPlan, "gone")).toBe("default");
  });
});
