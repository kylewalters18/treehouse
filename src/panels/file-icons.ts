import {
  SiC,
  SiCplusplus,
  SiCss,
  SiDocker,
  SiDotnet,
  SiGnubash,
  SiGo,
  SiGraphql,
  SiHtml5,
  SiJavascript,
  SiJson,
  SiKotlin,
  SiMarkdown,
  SiPhp,
  SiPython,
  SiReadme,
  SiRuby,
  SiRust,
  SiSass,
  SiSvelte,
  SiSwift,
  SiToml,
  SiTypescript,
  SiVuedotjs,
  SiYaml,
} from "react-icons/si";
import { DiJava } from "react-icons/di";
import {
  File,
  FileImage,
  FileLock,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType, SVGAttributes } from "react";

/// Anything that renders an SVG and accepts `size` + `color`. Both
/// react-icons (IconType) and lucide-react (LucideIcon) satisfy this
/// at the call sites we care about.
export type FileIconComponent = ComponentType<
  SVGAttributes<SVGElement> & { size?: number | string; color?: string }
>;

type Entry = { Icon: FileIconComponent; color: string };

/// Brand colors lifted from each language's official palette, dimmed
/// or shifted only where the dark editor chrome would otherwise crush
/// readability (e.g. Rust uses the lighter site color, not pure black).
const EXT: Record<string, Entry> = {
  ts: { Icon: SiTypescript, color: "#3178C6" },
  tsx: { Icon: SiTypescript, color: "#3178C6" },
  js: { Icon: SiJavascript, color: "#F7DF1E" },
  jsx: { Icon: SiJavascript, color: "#F7DF1E" },
  mjs: { Icon: SiJavascript, color: "#F7DF1E" },
  cjs: { Icon: SiJavascript, color: "#F7DF1E" },
  py: { Icon: SiPython, color: "#3776AB" },
  rs: { Icon: SiRust, color: "#DEA584" },
  go: { Icon: SiGo, color: "#00ADD8" },
  c: { Icon: SiC, color: "#A8B9CC" },
  h: { Icon: SiC, color: "#A8B9CC" },
  cpp: { Icon: SiCplusplus, color: "#00599C" },
  cc: { Icon: SiCplusplus, color: "#00599C" },
  hpp: { Icon: SiCplusplus, color: "#00599C" },
  cs: { Icon: SiDotnet, color: "#512BD4" },
  swift: { Icon: SiSwift, color: "#FA7343" },
  kt: { Icon: SiKotlin, color: "#7F52FF" },
  java: { Icon: DiJava, color: "#EA2D2E" },
  rb: { Icon: SiRuby, color: "#CC342D" },
  php: { Icon: SiPhp, color: "#777BB4" },
  html: { Icon: SiHtml5, color: "#E34F26" },
  htm: { Icon: SiHtml5, color: "#E34F26" },
  css: { Icon: SiCss, color: "#1572B6" },
  scss: { Icon: SiSass, color: "#CC6699" },
  sass: { Icon: SiSass, color: "#CC6699" },
  vue: { Icon: SiVuedotjs, color: "#4FC08D" },
  svelte: { Icon: SiSvelte, color: "#FF3E00" },
  md: { Icon: SiMarkdown, color: "#bfbfbf" },
  mdx: { Icon: SiMarkdown, color: "#bfbfbf" },
  json: { Icon: SiJson, color: "#cbd5e1" },
  jsonc: { Icon: SiJson, color: "#cbd5e1" },
  toml: { Icon: SiToml, color: "#9C4221" },
  yaml: { Icon: SiYaml, color: "#CB171E" },
  yml: { Icon: SiYaml, color: "#CB171E" },
  sh: { Icon: SiGnubash, color: "#4EAA25" },
  bash: { Icon: SiGnubash, color: "#4EAA25" },
  zsh: { Icon: SiGnubash, color: "#4EAA25" },
  graphql: { Icon: SiGraphql, color: "#E10098" },
  gql: { Icon: SiGraphql, color: "#E10098" },
  png: { Icon: FileImage, color: "#a78bfa" },
  jpg: { Icon: FileImage, color: "#a78bfa" },
  jpeg: { Icon: FileImage, color: "#a78bfa" },
  gif: { Icon: FileImage, color: "#a78bfa" },
  svg: { Icon: FileImage, color: "#a78bfa" },
  webp: { Icon: FileImage, color: "#a78bfa" },
  avif: { Icon: FileImage, color: "#a78bfa" },
  ico: { Icon: FileImage, color: "#a78bfa" },
};

const NAME: Record<string, Entry> = {
  Dockerfile: { Icon: SiDocker, color: "#2496ED" },
  dockerfile: { Icon: SiDocker, color: "#2496ED" },
  "README.md": { Icon: SiReadme, color: "#bfbfbf" },
  README: { Icon: SiReadme, color: "#bfbfbf" },
};

const FALLBACK: Entry = { Icon: File as LucideIcon, color: "#8C8C8C" };
const LOCK: Entry = { Icon: FileLock as LucideIcon, color: "#fda4af" };

export function iconForFile(name: string): Entry {
  if (NAME[name]) return NAME[name];
  if (name.endsWith(".lock") || name.startsWith(".env")) return LOCK;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return EXT[ext] ?? FALLBACK;
}

/// File-tree row text color tinted by git status. Mirrors VS Code's
/// modified=amber / added=green / deleted=red-strikethrough convention
/// so the Changes list and the file tree read consistently.
export function statusFilenameColor(kind: string): string {
  switch (kind) {
    case "added":
      return "text-emerald-300";
    case "modified":
      return "text-amber-300";
    case "deleted":
      return "text-rose-400 line-through";
    case "renamed":
      return "text-blue-300";
    case "untracked":
      return "text-emerald-300/80";
    default:
      return "text-neutral-200";
  }
}
