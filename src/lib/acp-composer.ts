import type { AcpConfigOption, AcpModes } from "@/ipc/types";

/// A select the composer can change, and how: a config option
/// (`session/set_config_option`) or the older mode list (`session/set_mode`).
export type ComposerPicker = { via: "config" | "mode"; option: AcpConfigOption };

export type ComposerControls = {
  model?: ComposerPicker;
  effort?: ComposerPicker;
  /// The permission mode (Manual / Accept edits / Auto / Bypass …).
  mode?: ComposerPicker;
  /// An on/off option shown as a toggle (Claude's "fast").
  fast?: { picker: ComposerPicker; on: boolean };
  /// Plan mode as a toggle, when the mode list has a `plan` entry.
  plan?: { active: boolean };
  /// Any other selects the agent offers, as generic pickers.
  extra: ComposerPicker[];
};

const isOnOff = (o: AcpConfigOption) =>
  o.options.length === 2 &&
  o.options.some((x) => x.value === "on") &&
  o.options.some((x) => x.value === "off");

/// Sort an agent's session settings into the composer's slots. Prefers
/// config options; falls back to the mode list for agents without them.
export function composerControls(
  config: AcpConfigOption[],
  modes: AcpModes | null,
): ComposerControls {
  const out: ComposerControls = { extra: [] };
  for (const option of config) {
    const picker: ComposerPicker = { via: "config", option };
    if (option.category === "model" && !out.model) out.model = picker;
    else if (option.category === "thought_level" && !out.effort) out.effort = picker;
    else if (option.category === "mode" && !out.mode) out.mode = picker;
    else if (isOnOff(option) && !out.fast) out.fast = { picker, on: option.current === "on" };
    else out.extra.push(picker);
  }
  if (!out.mode && modes && modes.available.length > 0) {
    out.mode = {
      via: "mode",
      option: {
        id: "mode",
        name: "Mode",
        description: null,
        category: "mode",
        current: modes.current,
        options: modes.available.map((m) => ({
          value: m.id,
          name: m.name,
          description: m.description,
        })),
      },
    };
  }
  if (out.mode?.option.options.some((o) => o.value === "plan")) {
    out.plan = { active: out.mode.option.current === "plan" };
  }
  return out;
}

/// The mode the plan toggle switches to: `plan`, or back to the mode used
/// before it (else the first non-plan mode, preferring Manual).
export function planToggleTarget(
  mode: AcpConfigOption,
  lastNonPlan: string | null,
): string {
  if (mode.current !== "plan") return "plan";
  const values = mode.options.map((o) => o.value).filter((v) => v !== "plan");
  if (lastNonPlan && values.includes(lastNonPlan)) return lastNonPlan;
  return values.includes("default") ? "default" : (values[0] ?? "plan");
}

/// Label for a picker's current value.
export function currentLabel(option: AcpConfigOption): string {
  return option.options.find((o) => o.value === option.current)?.name ?? option.current;
}
