// board-view proof (doc 18 slice 2) — the drop rules and card view-logic.
//
// The rule worth pinning is why a RUN card cannot be dragged. A run's column is derived from its tasks,
// so moving its card would ask the board to display something the run is not doing. The refusal is a
// message, not a silent spring-back — a board that ignores you teaches nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardCard } from "@agentry/workbench-shared";
import { COLUMNS, canDrop, countChips, progressOf, refusalReason, totalCards } from "../routes/board/board-view.js";

const item = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: "b-1",
  column: "backlog",
  title: "An item",
  origin: "item",
  updatedAt: "2026-08-22T00:00:00.000Z",
  ...over,
});

const run = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: "r-1",
  column: "running",
  title: "A run",
  origin: "run",
  run: "r-1",
  taskCounts: { todo: 1, "in-progress": 1, "in-review": 0, done: 2 },
  agentCount: 1,
  updatedAt: "2026-08-22T00:00:00.000Z",
  ...over,
});

test("the columns read left to right in lifecycle order", () => {
  assert.deepEqual(COLUMNS.map((c) => c.key), ["backlog", "ready", "running", "in-review", "done"]);
});

test("an item moves between backlog and ready — the two states an item has", () => {
  assert.equal(canDrop(item(), "ready"), true);
  assert.equal(canDrop(item({ column: "ready" }), "backlog"), true);
});

test("an item cannot be dropped into a run column — it has no run to be in", () => {
  for (const col of ["running", "in-review", "done"] as const) {
    assert.equal(canDrop(item(), col), false);
  }
});

test("a run card cannot be dragged anywhere — its column is derived, not chosen", () => {
  for (const col of ["backlog", "ready", "running", "in-review", "done"] as const) {
    assert.equal(canDrop(run(), col), false);
  }
});

test("a refusal explains itself, and says something different for a run than for an item", () => {
  const forRun = refusalReason(run(), "backlog");
  const forItem = refusalReason(item(), "in-review");
  assert.match(forRun, /comes from its tasks/);
  assert.match(forItem, /Backlog or Ready/);
  assert.match(forItem, /In review/, "the column's DISPLAY label, not the raw key");
  assert.notEqual(forRun, forItem);
});

test("progress is the done fraction of a run, and null for an item", () => {
  assert.equal(progressOf(run()), 0.5);
  assert.equal(progressOf(item()), null);
});

test("a run with zero tasks has no progress bar rather than a 0% or NaN one", () => {
  assert.equal(progressOf(run({ taskCounts: { todo: 0, "in-progress": 0, "in-review": 0, done: 0 } })), null);
});

test("count chips omit the empty buckets and keep lifecycle order", () => {
  assert.deepEqual(countChips(run()), [
    { label: "in progress", n: 1 },
    { label: "to do", n: 1 },
    { label: "done", n: 2 },
  ]);
});

test("an item contributes no count chips", () => {
  assert.deepEqual(countChips(item()), []);
});

test("totalCards counts every column", () => {
  assert.equal(
    totalCards({ backlog: [item()], ready: [], running: [run()], "in-review": [], done: [run(), run()] }),
    4,
  );
});
