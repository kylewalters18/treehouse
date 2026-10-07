import type { ForgeJob, ForgeLogSection } from "@/ipc/types";
import { ansiToSegments, stripAnsi, type AnsiSegment } from "@/lib/ansi";

/// "6s", "1m 42s", "1h 3m".
export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/// How long a job ran — up to `now` while it's still running.
export function jobDurationSecs(job: ForgeJob, now = Date.now()): number | null {
  const start = ms(job.startedAt);
  if (start === null) return null;
  const end = ms(job.finishedAt) ?? (job.status === "running" ? now : null);
  return end === null ? null : (end - start) / 1000;
}

/// Wall time from the first job starting to the last one finishing.
export function pipelineSpanSecs(jobs: ForgeJob[], now = Date.now()): number | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const j of jobs) {
    const start = ms(j.startedAt);
    if (start === null) continue;
    const end = ms(j.finishedAt) ?? (j.status === "running" ? now : start);
    first = first === null ? start : Math.min(first, start);
    last = last === null ? end : Math.max(last, end);
  }
  return first === null || last === null ? null : (last - first) / 1000;
}

/// The job to show when a pipeline opens: a real failure first, then
/// whatever is running, then an allowed failure, then the first job.
export function defaultJob(jobs: ForgeJob[]): ForgeJob | undefined {
  return (
    jobs.find((j) => j.status === "failed" && !j.allowFailure) ??
    jobs.find((j) => j.status === "running") ??
    jobs.find((j) => j.status === "failed") ??
    jobs[0]
  );
}

/// The section to open first: the step the forge says failed (GitHub);
/// for a failed GitLab job, its script section; while running, the last
/// one. `-1` leaves everything collapsed.
export function defaultSection(sections: ForgeLogSection[], jobStatus: string): number {
  const failedStep = sections.findIndex((s) => s.status === "failed");
  if (failedStep >= 0) return failedStep;
  if (jobStatus === "failed") {
    const script = findLastIndex(sections, (s) => /script/i.test(s.name));
    if (script >= 0) return script;
    return findLastIndex(sections, (s) => s.name !== "");
  }
  if (jobStatus === "running") return sections.length - 1;
  return -1;
}

function findLastIndex<T>(xs: T[], pred: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i])) return i;
  return -1;
}

/// Split ANSI text into lines of styled segments, carrying styles across
/// line breaks.
export function ansiLines(text: string): AnsiSegment[][] {
  const lines: AnsiSegment[][] = [[]];
  for (const seg of ansiToSegments(text)) {
    const parts = seg.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, style: seg.style });
    });
  }
  return lines;
}

/// Keep the end of a log for an agent prompt — where failures are.
export function tailText(text: string, maxChars = 16_000): string {
  if (text.length <= maxChars) return text;
  const cut = text.indexOf("\n", text.length - maxChars);
  return `…(truncated)…\n${text.slice(cut < 0 ? text.length - maxChars : cut + 1)}`;
}

/// The "send to agent" prompt for a job, built from one section when the
/// log has a clear culprit, else the whole log.
export function agentPrompt(
  job: ForgeJob,
  sections: ForgeLogSection[],
  focus: number,
): string {
  const failed = job.status === "failed";
  const section = sections[focus];
  const text = section
    ? section.text
    : sections.map((s) => (s.name ? `── ${s.name} ──\n${s.text}` : s.text)).join("\n");
  const where = section?.name ? ` (step \`${section.name}\`)` : "";
  const lead = failed
    ? `The CI job \`${job.name}\` failed${where}.`
    : `Here is the log for CI job \`${job.name}\` (${job.status})${where}.`;
  const ask = failed ? "Please diagnose and fix the cause." : "Use it as context.";
  return `${lead} Log:\n\n\`\`\`\n${tailText(stripAnsi(text))}\n\`\`\`\n\n${ask}`;
}
