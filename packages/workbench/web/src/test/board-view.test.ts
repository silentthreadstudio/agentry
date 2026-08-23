// board-view proof (doc 18 slice 2) — the drop rules and card view-logic.
//
// The rule worth pinning is why a RUN card cannot be dragged. A run's column is derived from its tasks,
// so moving its card would ask the board to display something the run is not doing. The refusal is a
// message, not a silent spring-back — a board that ignores you teaches nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardCard } from "@agentry/workbench-shared";
import {
  COLUMNS,
  blockedLabel,
  canDrop,
  conflictText,
  countChips,
  elapsedOf,
  initialsOf,
  progressOf,
  refusalReason,
  totalCards,
} from "../routes/board/board-view.js";

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

// ── presence + the two signals (slice 3) ───────────────────────────────────────────────────────────
test("initials come from the role, so the roster is scannable without a legend", () => {
  assert.equal(initialsOf({ id: "r/implementer", role: "implementer", state: "working", task: null }), "IM");
  assert.equal(initialsOf({ id: "r/verifier", role: "verifier", state: "working", task: null }), "VE");
});

test("elapsed reads compactly across the scales that matter", () => {
  const at = (msAgo: number) => ({
    id: "a",
    role: "implementer",
    state: "working" as const,
    task: null,
    since: new Date(1_000_000_000_000 - msAgo).toISOString(),
  });
  const now = 1_000_000_000_000;
  assert.equal(elapsedOf(at(5_000), now), "5s");
  assert.equal(elapsedOf(at(4 * 60_000), now), "4m");
  assert.equal(elapsedOf(at(3 * 3_600_000), now), "3h");
  assert.equal(elapsedOf(at(2 * 86_400_000), now), "2d");
});

test("no `since` means NO timer — an elapsed time with no start can only be invented", () => {
  assert.equal(elapsedOf({ id: "a", role: "implementer", state: "working", task: null }), null);
});

test("an unparseable `since` shows no timer rather than NaN", () => {
  assert.equal(elapsedOf({ id: "a", role: "x", state: "working", task: null, since: "not a date" }), null);
});

test("a future `since` clamps to 0 rather than showing a negative age", () => {
  const now = 1_000_000_000_000;
  assert.equal(elapsedOf({ id: "a", role: "x", state: "working", task: null, since: new Date(now + 5000).toISOString() }, now), "0s");
});

test("the conflict banner names the FILE and the runs — what breaks, and where to stop it", () => {
  const text = conflictText({ files: ["auth/middleware.ts"], cards: ["r-a", "r-b"], tasks: ["r-a/001", "r-b/002"] });
  assert.match(text, /auth\/middleware\.ts/);
  assert.match(text, /r-a and r-b/);
  assert.match(text, /clobber/);
});

test("the blocked chip names the blocker rather than saying a bare 'blocked'", () => {
  assert.equal(blockedLabel(item({ blocked: [{ task: "002", by: ["001"] }] })), "blocked by 001");
});

test("more than one blocked task is summarised, not truncated silently", () => {
  const label = blockedLabel(item({ blocked: [{ task: "002", by: ["001"] }, { task: "003", by: ["002"] }] }));
  assert.equal(label, "blocked by 001 (+1 more)");
});

test("a card with nothing blocked has no chip", () => {
  assert.equal(blockedLabel(item()), null);
});
