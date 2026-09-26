import { cn } from "./cn";

/// Shared class recipes for pane headers so every pane's chrome lines up:
/// same strip height, same surface, same active-state treatment.
///
/// - *Section* tabs switch what a pane shows (Terminal / Problems / CI,
///   Files / Changes): uppercase labels with an accent underline.
/// - *Instance* tabs are open things of one kind (agent sessions,
///   terminals): editor-style tabs with an accent line on top.

export const sectionStrip =
  "flex h-[34px] shrink-0 items-stretch gap-3 border-b border-neutral-800 bg-chrome px-3";

export function sectionTab(active: boolean) {
  return cn(
    "-mb-px flex items-center gap-1.5 border-b-[1.5px] text-[10.5px] font-medium uppercase tracking-[0.08em] transition-colors",
    active
      ? "border-blue-400 text-neutral-100"
      : "border-transparent text-neutral-500 hover:text-neutral-300",
  );
}

export const instanceStrip =
  "flex h-[30px] shrink-0 items-stretch overflow-x-auto border-b border-neutral-800 bg-chrome";

export function instanceTab(active: boolean) {
  return cn(
    "group relative flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-neutral-800 px-3 text-[11px]",
    active
      ? "bg-neutral-950 text-neutral-100 before:absolute before:inset-x-0 before:top-0 before:h-[1.5px] before:bg-blue-400"
      : "text-neutral-500 hover:bg-neutral-900/60 hover:text-neutral-300",
  );
}

/// Close glyph inside an instance tab: hidden until the tab is hovered,
/// always shown on the active tab.
export function instanceTabClose(active: boolean) {
  return cn(
    "flex h-4 w-4 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-100",
    active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
  );
}

export const iconButton =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

/// Small count pill for tabs. `tone` picks the semantic color; neutral
/// otherwise.
export function countBadge(tone: "accent" | "danger" | "neutral") {
  return cn(
    "rounded-full px-1.5 font-mono text-[10px] font-medium normal-case leading-4 tracking-normal tabular-nums",
    tone === "danger" && "bg-rose-400/15 text-rose-400",
    tone === "accent" && "bg-blue-400/15 text-blue-400",
    tone === "neutral" && "bg-neutral-800 text-neutral-400",
  );
}
