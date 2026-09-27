import { Asterisk, Ghost, Hexagon, type LucideProps } from "lucide-react";
import type { AgentBackendKind } from "@/ipc/types";
import { cn } from "@/lib/cn";

const ICONS = { claudeCode: Asterisk, codex: Hexagon, kiro: Ghost };

const TINTS: Record<AgentBackendKind, string> = {
  claudeCode: "text-orange-400",
  codex: "text-teal-400",
  kiro: "text-violet-400",
};

/// Per-backend glyph for agent tabs and the launch menu, so Claude /
/// Codex / Kiro sessions are distinguishable at a glance.
export function BackendIcon({
  backend,
  className,
  ...rest
}: { backend: AgentBackendKind } & LucideProps) {
  const Icon = ICONS[backend];
  return (
    <Icon
      size={12}
      strokeWidth={2.25}
      className={cn("shrink-0", TINTS[backend], className)}
      {...rest}
    />
  );
}
