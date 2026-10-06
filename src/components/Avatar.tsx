import { cn } from "@/lib/cn";

/// Initials on a hue hashed from the name — stable per person, no network.
export function Avatar({
  name,
  size = 24,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const initials =
    name
      .replace(/^@/, "")
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  return (
    <span
      title={name}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold text-white/90",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `hsl(${nameHue(name)} 45% 38%)`,
      }}
    >
      {initials}
    </span>
  );
}

export function nameHue(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}
