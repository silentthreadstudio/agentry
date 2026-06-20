// Works-home view-logic — everything the route derives, formats, or pins as a view constant, kept out of
// Works.tsx so the component is pure presentation and this stays unit-testable without rendering: the four
// KPI aggregates + the Active filter predicate, the run-host URL, the card's primary-status + aura hue, the
// relative-time + initials formatters, and the filter/count vocabularies. No JSX, no React.
import type { RunSummary } from "@agentry/workbench-shared";
import { workSlug } from "@agentry/workbench-shared";
import type { DotStatus, FlowTaskStatus } from "../../ui/index.js";

type TaskCounts = RunSummary["taskCounts"];
type TaskStatus = keyof TaskCounts;

const TASK_STATUSES: TaskStatus[] = ["in-progress", "in-review", "todo", "done"];

/** Total tasks in a run across every lifecycle bucket. */
export function tasksTotal(counts: TaskCounts): number {
  return TASK_STATUSES.reduce((n, s) => n + (counts[s] ?? 0), 0);
}

/** A run is "active" while any task is still moving (not yet all done / there is live work). */
export function isActiveRun(w: RunSummary): boolean {
  return (
    (w.taskCounts["in-progress"] ?? 0) > 0 ||
    (w.taskCounts["in-review"] ?? 0) > 0 ||
    (w.taskCounts.todo ?? 0) > 0
  );
}

/** The four KPI aggregates the hero tiles show — all derived from the loaded RunSummary[]. */
export interface Kpis {
  activeRuns: number; // runs with any task still moving
  totalRuns: number; // every run in the project
  inProgress: number; // sum of in-progress tasks across all runs
  agentsLive: number; // sum of run roster sizes
  pctDone: number; // done tasks / all tasks across all runs (0 when there are no tasks)
}

export function deriveKpis(works: RunSummary[]): Kpis {
  let inProgress = 0;
  let agentsLive = 0;
  let done = 0;
  let total = 0;
  for (const w of works) {
    inProgress += w.taskCounts["in-progress"] ?? 0;
    agentsLive += w.agentCount ?? 0;
    done += w.taskCounts.done ?? 0;
    total += tasksTotal(w.taskCounts);
  }
  return {
    activeRuns: works.filter(isActiveRun).length,
    totalRuns: works.length,
    inProgress,
    agentsLive,
    pctDone: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}

// ── Card view-logic + vocabularies ──────────────────────────────────────────────────────────────────

/** The host a run card opens: same host + port, only the subdomain changes (bare → <workSlug>). The slug
 *  is the short, stable label both halves compute; the server resolves it back to the run id. */
export function runHref(runId: string): string {
  const { protocol, hostname, port } = location;
  const baseHost = hostname.replace(/^[^.]+\.(?=localhost$)/, ""); // strip any existing run subdomain
  const host = `${workSlug(runId)}.${baseHost}${port ? `:${port}` : ""}`;
  return `${protocol}//${host}/`;
}

// The card's headline status: the most "live" bucket that has work, so the eye lands on what's moving.
const STATUS_PRIORITY: FlowTaskStatus[] = ["in-progress", "in-review", "todo", "done"];
export function primaryStatus(counts: Record<FlowTaskStatus, number>): DotStatus {
  for (const s of STATUS_PRIORITY) {
    if ((counts[s] ?? 0) > 0) return s;
  }
  return "done";
}

/** The per-status count chips shown on a card, in lifecycle order. */
export const COUNT_ORDER: { key: FlowTaskStatus; label: string }[] = [
  { key: "in-progress", label: "in progress" },
  { key: "in-review", label: "in review" },
  { key: "todo", label: "to do" },
  { key: "done", label: "done" },
];

/** The status-tint of a run's aura blob — matches its primary status's hue. */
export const AURA_HUE: Record<DotStatus, string> = {
  "in-progress": "var(--prog)",
  "in-review": "var(--rev)",
  todo: "var(--todo)",
  done: "var(--done)",
  blocked: "var(--block)",
};

/** A compact "just now / 5m ago / 3h ago / 2d ago" from an ISO timestamp. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** The agent-avatar initials — first two letters of the run's leading word, uppercased. */
export function runInitials(run: string): string {
  const first = run.split(/[-_\s]/).filter(Boolean)[0] ?? run;
  return first.slice(0, 2).toUpperCase();
}

/** The All/Active/Done filter vocabulary the section bar renders. */
export type WorksFilter = "all" | "active" | "done";
export const FILTERS: { key: WorksFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "done", label: "Done" },
];
