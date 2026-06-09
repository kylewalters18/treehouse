import type { ForgeJob } from "@/ipc/types";

/// Queued-but-not-yet-running states. GitLab reports several flavors of
/// "waiting"; we treat them all as one "pending" bucket.
const PENDING_STATES = [
  "pending",
  "created",
  "scheduled",
  "waiting_for_resource",
  "preparing",
];
/// Terminal states that count as a clean finish (nothing went wrong).
const DONE_OK_STATES = ["success", "skipped", "manual"];

/// GitLab spells it "canceled"; GitHub conclusions use "cancelled". Accept both.
function isCanceled(s: string): boolean {
  return s === "canceled" || s === "cancelled";
}

/// Roll-up status for a stage from its jobs, most-salient first:
/// failed → running → pending → success (all clean) → canceled → unknown.
/// Putting `success` before `canceled` means a stage is only "canceled" when
/// it has a canceled job and no clean all-green finish — a stage that fully
/// succeeded but had one optional job canceled still reads as canceled, which
/// is the informative signal (something didn't run to completion).
export function stageStatus(jobs: ForgeJob[]): string {
  if (jobs.some((j) => j.status === "failed")) return "failed";
  if (jobs.some((j) => j.status === "running")) return "running";
  if (jobs.some((j) => PENDING_STATES.includes(j.status))) return "pending";
  if (jobs.length > 0 && jobs.every((j) => DONE_OK_STATES.includes(j.status)))
    return "success";
  if (jobs.some((j) => isCanceled(j.status))) return "canceled";
  return "";
}

export type CiVisual = {
  /// Tailwind classes for the dot — a fill (`bg-*`) or a ring (`border-*`
  /// + `bg-transparent`) so hollow states read differently at a glance.
  dot: string;
  /// Pulse to signal in-flight work.
  pulse: boolean;
  /// Human label, shown as the dot's tooltip.
  label: string;
};

/// Map a CI status (a raw job status or a `stageStatus` roll-up) to a dot
/// visual. Each state gets its own treatment so pending/running/canceled/
/// skipped/manual aren't collapsed into one amber-or-gray blob:
///   passed   → solid green      failed   → solid red
///   running  → solid blue, pulse pending  → solid amber
///   canceled → solid slate       manual   → hollow sky ring
///   skipped  → hollow gray ring   unknown  → solid gray
export function ciStatusVisual(status: string): CiVisual {
  if (status === "success")
    return { dot: "bg-emerald-500", pulse: false, label: "passed" };
  if (status === "failed")
    return { dot: "bg-red-500", pulse: false, label: "failed" };
  if (status === "running")
    return { dot: "bg-blue-500", pulse: true, label: "running" };
  if (PENDING_STATES.includes(status))
    return { dot: "bg-amber-500", pulse: false, label: "pending" };
  if (isCanceled(status))
    return { dot: "bg-slate-400", pulse: false, label: "canceled" };
  if (status === "manual")
    return { dot: "border border-sky-500 bg-transparent", pulse: false, label: "manual" };
  if (status === "skipped")
    return { dot: "border border-neutral-600 bg-transparent", pulse: false, label: "skipped" };
  return { dot: "bg-neutral-600", pulse: false, label: status || "unknown" };
}
