// works-kpis — the Works-home hero aggregates derived client-side from /api/works (Task 002). Covers the
// four KPI tiles (active runs, in-progress total, agents live, % done) and the Active/Done filter
// predicate, with the real edges: empty list, a zero-task run (no division-by-zero), all-done vs active.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunSummary } from "@agentry/workbench-shared";
import { deriveKpis, isActiveRun, tasksTotal } from "../routes/works-kpis.js";

function run(over: Partial<RunSummary> & { run: string }): RunSummary {
  return {
    title: over.run,
    taskCounts: { todo: 0, "in-progress": 0, "in-review": 0, done: 0 },
    agentCount: 0,
    updatedAt: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

test("deriveKpis on an empty list is all zeros and pctDone 0 (no division by zero)", () => {
  const k = deriveKpis([]);
  assert.deepEqual(k, { activeRuns: 0, totalRuns: 0, inProgress: 0, agentsLive: 0, pctDone: 0 });
});

test("deriveKpis sums in-progress tasks and agent rosters across runs", () => {
  const k = deriveKpis([
    run({ run: "a", taskCounts: { todo: 1, "in-progress": 2, "in-review": 0, done: 3 }, agentCount: 2 }),
    run({ run: "b", taskCounts: { todo: 0, "in-progress": 1, "in-review": 1, done: 1 }, agentCount: 3 }),
  ]);
  assert.equal(k.inProgress, 3); // 2 + 1
  assert.equal(k.agentsLive, 5); // 2 + 3
  assert.equal(k.totalRuns, 2);
});

test("deriveKpis pctDone is done / all-tasks rounded across runs", () => {
  // run a: 4 done of 6; run b: 1 done of 3 → 5 done of 9 → 56%
  const k = deriveKpis([
    run({ run: "a", taskCounts: { todo: 1, "in-progress": 1, "in-review": 0, done: 4 } }),
    run({ run: "b", taskCounts: { todo: 1, "in-progress": 1, "in-review": 0, done: 1 } }),
  ]);
  assert.equal(k.pctDone, 56); // Math.round(5/9*100)
});

test("activeRuns counts only runs with a task still moving; all-done runs are inactive", () => {
  const k = deriveKpis([
    run({ run: "moving", taskCounts: { todo: 0, "in-progress": 1, "in-review": 0, done: 4 } }),
    run({ run: "queued", taskCounts: { todo: 2, "in-progress": 0, "in-review": 0, done: 0 } }),
    run({ run: "finished", taskCounts: { todo: 0, "in-progress": 0, "in-review": 0, done: 5 } }),
  ]);
  assert.equal(k.activeRuns, 2); // moving + queued, not finished
});

test("isActiveRun is true for todo/in-progress/in-review work and false when only done", () => {
  assert.equal(isActiveRun(run({ run: "p", taskCounts: { todo: 0, "in-progress": 1, "in-review": 0, done: 0 } })), true);
  assert.equal(isActiveRun(run({ run: "r", taskCounts: { todo: 0, "in-progress": 0, "in-review": 2, done: 0 } })), true);
  assert.equal(isActiveRun(run({ run: "t", taskCounts: { todo: 1, "in-progress": 0, "in-review": 0, done: 0 } })), true);
  assert.equal(isActiveRun(run({ run: "d", taskCounts: { todo: 0, "in-progress": 0, "in-review": 0, done: 9 } })), false);
});

test("tasksTotal sums every lifecycle bucket; a zero-task run totals 0", () => {
  assert.equal(tasksTotal({ todo: 1, "in-progress": 2, "in-review": 3, done: 4 }), 10);
  assert.equal(tasksTotal({ todo: 0, "in-progress": 0, "in-review": 0, done: 0 }), 0);
});
