// BoardReader proof (doc 18 slice 2) — the column derivation, against fakes (no disk).
//
// The property under test is AC4: **the column comes from stored state, server-side**. Everything here
// is about a card landing in exactly one place, and about the two states where naive logic gets it
// wrong — a run with no tasks yet, and an item whose run has vanished.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardReader, runColumn, type BacklogSource } from "../src/application/board-reader.js";
import { WorkReader } from "../src/application/work-reader.js";
import type { Clock, RunFiles, WorkRepository } from "../src/domain/ports.js";
import type { BacklogItem } from "@agentry/flow/domain/backlog";

const clock: Clock = { now: () => "2026-08-22T00:00:00.000Z" };

function runFiles(run: string, statuses: string[], owns: string[][] = []): RunFiles {
  return {
    run,
    routing: { shape: "decompose+verify", kind: "feature" },
    spec: { frontmatter: { kind: "spec" }, body: "# Spec" },
    plan: { frontmatter: { id: "plan", title: run }, body: "# Plan" },
    adrs: [],
    tasks: statuses.map((status, i) => ({
      taskNo: String(i + 1).padStart(3, "0"),
      frontmatter: { title: `t${i}`, status, deps: [] },
      body: owns[i] ? `## Contract\nowns:\n${owns[i]!.map((o) => `  - ${o}`).join("\n")}\n` : "",
    })),
  };
}

function reader(runs: RunFiles[]): WorkReader {
  const repo: WorkRepository = {
    listRuns: () => runs.map((r) => r.run),
    readRun: (id) => runs.find((r) => r.run === id),
  };
  return new WorkReader(repo, clock);
}

const items = (list: Partial<BacklogItem>[]): BacklogSource => ({
  list: () =>
    list.map((i) => ({
      id: "b-x",
      title: "item",
      kind: "feature",
      status: "backlog",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
      runs: [],
      body: "",
      ...i,
    })) as BacklogItem[],
});

// ── the column rule ────────────────────────────────────────────────────────────────────────────────
test("a run with any task in-review is in-review — waiting on a human outranks work still moving", () => {
  assert.equal(runColumn({ todo: 3, "in-progress": 1, "in-review": 1, done: 0 }), "in-review");
});

test("a run whose every task is done is done", () => {
  assert.equal(runColumn({ todo: 0, "in-progress": 0, "in-review": 0, done: 4 }), "done");
});

test("a run with NO tasks yet is running, not done — a fresh run must not file itself as complete", () => {
  assert.equal(runColumn({ todo: 0, "in-progress": 0, "in-review": 0, done: 0 }), "running");
});

test("a run with work left is running", () => {
  assert.equal(runColumn({ todo: 2, "in-progress": 1, "in-review": 0, done: 3 }), "running");
});

// ── the board ──────────────────────────────────────────────────────────────────────────────────────
test("items and runs land in their columns, and nothing appears twice", () => {
  const board = new BoardReader(
    reader([runFiles("r-live", ["in-progress"]), runFiles("r-done", ["done"])]),
    items([{ id: "b-parked", status: "backlog" }, { id: "b-queued", status: "ready" }]),
  ).read();

  assert.deepEqual(board.columns.backlog.map((c) => c.id), ["b-parked"]);
  assert.deepEqual(board.columns.ready.map((c) => c.id), ["b-queued"]);
  assert.deepEqual(board.columns.running.map((c) => c.id), ["r-live"]);
  assert.deepEqual(board.columns.done.map((c) => c.id), ["r-done"]);

  const all = Object.values(board.columns).flat();
  assert.equal(new Set(all.map((c) => c.id)).size, all.length, "no card appears in two columns");
});

test("a claimed item hands its card to the run, and rides along as provenance", () => {
  const board = new BoardReader(
    reader([runFiles("r-claimed", ["in-progress"])]),
    items([{ id: "b-src", status: "claimed", runs: ["r-claimed"], kind: "perf" }]),
  ).read();

  const cards = Object.values(board.columns).flat();
  assert.equal(cards.length, 1, "the item does NOT also appear — the run card IS the item now");
  assert.equal(cards[0]?.id, "r-claimed");
  assert.equal(cards[0]?.origin, "run");
  assert.equal(cards[0]?.item, "b-src", "provenance survives the hand-off");
});

test("a claimed item whose run VANISHED falls back to ready — intent outlives its run", () => {
  const board = new BoardReader(
    reader([]), // the run is gone
    items([{ id: "b-orphan", status: "claimed", runs: ["r-deleted"] }]),
  ).read();

  assert.deepEqual(board.columns.ready.map((c) => c.id), ["b-orphan"]);
  assert.equal(board.columns.ready[0]?.origin, "item");
});

test("a done item stays in done rather than falling back to ready", () => {
  const board = new BoardReader(reader([]), items([{ id: "b-shipped", status: "done" }])).read();
  assert.deepEqual(board.columns.done.map((c) => c.id), ["b-shipped"]);
});

test("a run card carries the tally and roster the Works list showed — one read-model, no disagreement", () => {
  const board = new BoardReader(reader([runFiles("r-1", ["done", "in-progress"])]), items([])).read();
  const card = board.columns.running[0];
  assert.equal(card?.taskCounts?.done, 1);
  assert.equal(card?.taskCounts?.["in-progress"], 1);
  assert.equal(typeof card?.agentCount, "number");
  assert.equal(card?.shape, "decompose+verify");
});

test("cards are newest-first within a column", () => {
  const board = new BoardReader(
    reader([]),
    items([
      { id: "b-old", status: "backlog", updatedAt: "2026-08-01T00:00:00.000Z" },
      { id: "b-new", status: "backlog", updatedAt: "2026-08-22T00:00:00.000Z" },
    ]),
  ).read();
  assert.deepEqual(board.columns.backlog.map((c) => c.id), ["b-new", "b-old"]);
});

test("an empty project yields five empty columns, not a missing key", () => {
  const board = new BoardReader(reader([]), items([])).read();
  assert.deepEqual(Object.keys(board.columns).sort(), ["backlog", "done", "in-review", "ready", "running"]);
  assert.equal(Object.values(board.columns).flat().length, 0);
});


// ── presence, blocking, and the overlap warning (slice 3) ──────────────────────────────────────────

const roster = (agents: { id: string; role: string; state: "working" | "blocked" | "done"; task: string | null }[]) => ({
  roster: () => agents,
});

test("presence lands on the run card, joined to the file its task owns (AC8/AC9)", () => {
  const board = new BoardReader(
    reader([runFiles("r-1", ["in-progress"], [["auth/middleware.ts"]])]),
    items([]),
    roster([{ id: "r-1/implementer", role: "implementer", state: "working", task: "001" }]),
  ).read();

  const agents = board.columns.running[0]?.agents;
  assert.equal(agents?.length, 1);
  assert.equal(agents?.[0]?.role, "implementer");
  assert.equal(agents?.[0]?.file, "auth/middleware.ts", "who is touching what");
});

test("an agent on no task carries no file rather than an invented one", () => {
  const board = new BoardReader(
    reader([runFiles("r-1", ["in-progress"], [["a.ts"]])]),
    items([]),
    roster([{ id: "r-1/architect", role: "architect", state: "working", task: null }]),
  ).read();
  assert.equal(board.columns.running[0]?.agents?.[0]?.file, undefined);
});

test("a task whose deps are unfinished is reported blocked, naming the blocker (AC10)", () => {
  const files = runFiles("r-1", ["in-progress", "todo"]);
  files.tasks[1]!.frontmatter.deps = [1];
  const board = new BoardReader(reader([files]), items([])).read();
  assert.deepEqual(board.columns.running[0]?.blocked, [{ task: "002", by: ["001"] }]);
});

test("a dep that is DONE does not block", () => {
  const files = runFiles("r-1", ["done", "in-progress"]);
  files.tasks[1]!.frontmatter.deps = [1];
  const board = new BoardReader(reader([files]), items([])).read();
  assert.equal(board.columns.running[0]?.blocked, undefined);
});

test("a dep naming no known task is ignored — a typo must not invent a blockage", () => {
  const files = runFiles("r-1", ["in-progress"]);
  files.tasks[0]!.frontmatter.deps = [99];
  const board = new BoardReader(reader([files]), items([])).read();
  assert.equal(board.columns.running[0]?.blocked, undefined);
});

test("two IN-PROGRESS tasks owning the same file raise a conflict, across runs (AC11)", () => {
  const board = new BoardReader(
    reader([
      runFiles("r-a", ["in-progress"], [["auth/middleware.ts", "a.ts"]]),
      runFiles("r-b", ["in-progress"], [["auth/middleware.ts"]]),
    ]),
    items([]),
  ).read();

  assert.equal(board.conflicts.length, 1);
  assert.deepEqual(board.conflicts[0]?.files, ["auth/middleware.ts"]);
  assert.deepEqual(board.conflicts[0]?.cards.sort(), ["r-a", "r-b"]);
  assert.deepEqual(board.conflicts[0]?.tasks.sort(), ["r-a/001", "r-b/001"]);
  // both cards are marked, so the board can tint them, not just print a banner
  for (const card of board.columns.running) assert.equal(card.conflict, true);
});

test("the same file owned at DIFFERENT times is a sequence, not a clobber — no conflict", () => {
  const board = new BoardReader(
    reader([
      runFiles("r-a", ["done"], [["auth/middleware.ts"]]),
      runFiles("r-b", ["in-progress"], [["auth/middleware.ts"]]),
    ]),
    items([]),
  ).read();
  assert.deepEqual(board.conflicts, []);
});

test("disjoint contracts raise nothing — the parallel-safe case stays quiet", () => {
  const board = new BoardReader(
    reader([runFiles("r-a", ["in-progress"], [["a.ts"]]), runFiles("r-b", ["in-progress"], [["b.ts"]])]),
    items([]),
  ).read();
  assert.deepEqual(board.conflicts, []);
  assert.ok(board.columns.running.every((c) => c.conflict === undefined));
});

test("a board with no roster source still reads — presence is optional, not required", () => {
  const board = new BoardReader(reader([runFiles("r-1", ["in-progress"])]), items([])).read();
  assert.equal(board.columns.running[0]?.agents, undefined);
});
