// Pure aggregation for the Works home — the four KPI tiles and the All/Active/Done filter predicate,
// derived client-side from the loaded RunSummary[] (no I/O, no React). Split out of Works.tsx so the
// arithmetic that drives the hero metrics is unit-testable without rendering the route.
import type { RunSummary } from "@agentry/workbench-shared";

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
