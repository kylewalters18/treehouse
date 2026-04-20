import { useToastsStore } from "@/stores/toasts";
import { cn } from "@/lib/cn";

export function Toaster() {
  const toasts = useToastsStore((s) => s.toasts);
  const dismiss = useToastsStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur",
            t.kind === "error" &&
              "border-red-900/60 bg-red-950/80 text-red-200",
            t.kind === "success" &&
              "border-emerald-900/60 bg-emerald-950/80 text-emerald-200",
            t.kind === "info" &&
              "border-neutral-800 bg-neutral-900/90 text-neutral-200",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{t.title}</div>
              {t.body && (
                <div className="mt-1 whitespace-pre-wrap break-words text-[11px] opacity-80">
                  {t.body}
                </div>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-[11px] opacity-60 hover:opacity-100"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
