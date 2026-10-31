// WorkReader proof — the application fold (task 008). Two layers of evidence:
//  1. against a FAKE WorkRepository, so the fold (summary tally, title, docs, doc-index delegation) is
//     tested deterministically with no fs — the port purity ADR-001 buys.
//  2. against the REAL FsWorkRepository on the committed fixture run (copied into a temp `.agentry/work/`
//     tree by the shared loader, so it is CI-portable — the live `.agentry/work/` is gitignored), so
//     `read` is proven to return a populated `RunSummary` + doc index for genuine on-disk data (the
//     acceptance).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { WorkReader } from "../src/application/work-reader.js";
import type { Clock, RunFiles, WorkRepository } from "../src/domain/ports.js";
import { FsWorkRepository } from "../src/persistence/fs-work-repository.js";
import { FIXTURE_RUN, loadFixtureRun } from "./fixtures/load-fixture-run.js";

// A frozen clock so `updatedAt` is deterministic under test.
const fixedClock: Clock = { now: () => "2026-06-19T00:00:00.000Z" };

// A fake repository serving a fixed RunFiles — the application is unit-testable with no disk.
function fakeRepo(files: RunFiles): WorkRepository {
  return {
    listRuns: () => [files.run],
    readRun: (run) => (run === files.run ? files : undefined),
  };
}

function sampleFiles(): RunFiles {
  return {
    run: "sample",
    routing: { shape: "decompose+verify", kind: "feature" },
    spec: { frontmatter: { kind: "spec" }, body: "# Spec" },
    plan: { frontmatter: { id: "plan", title: "The Plan" }, body: "# Plan" },
    adrs: [{ frontmatter: { id: "ADR-001", title: "stateless" }, body: "# ADR-001" }],
    tasks: [
      { taskNo: "001", frontmatter: { title: "a", status: "done", deps: [] }, body: "" },
      {
        taskNo: "002",
        frontmatter: { title: "b", status: "in-progress", lockedBy: "implementer", deps: [1] },
        body: "task 2 body",
      },
      { taskNo: "003", frontmatter: { title: "c", deps: [1] }, body: "" }, // no status → todo bucket
    ],
  };
}

test("read returns a RunSummary with task tally by FLOW's closed status", () => {
  const reader = new WorkReader(fakeRepo(sampleFiles()), fixedClock);
  const result = reader.read("sample");
  assert.ok(result, "the run reads");

  assert.equal(result.summary.run, "sample");
  assert.equal(result.summary.title, "The Plan", "title from the plan frontmatter");
  assert.equal(
    result.summary.updatedAt,
    "2026-06-19T00:00:00.000Z",
    "updatedAt from the injected clock",
  );
  // 001 done, 002 in-progress, 003 status-less → todo; every bucket present even at 0.
  assert.deepEqual(result.summary.taskCounts, {
    todo: 1,
    "in-progress": 1,
    "in-review": 0,
    done: 1,
  });
});

test("read returns a doc index derived from the same files (buildDocIndex delegation)", () => {
  const reader = new WorkReader(fakeRepo(sampleFiles()), fixedClock);
  const result = reader.read("sample");
  assert.ok(result, "the run reads");
  // The index carries an entry per artifact — proof buildDocIndex ran on these files.
  assert.ok(
    result.docIndex.some((d) => d.id === "spec"),
    "the spec",
  );
  assert.ok(
    result.docIndex.some((d) => d.id === "task-002"),
    "a task",
  );
});

test("read ferries docs keyed with buildDocIndex's ids (spec/plan/adr/task)", () => {
  const reader = new WorkReader(fakeRepo(sampleFiles()), fixedClock);
  const result = reader.read("sample");
  assert.ok(result, "the run reads");
  const ids = result.docs.map((d) => d.id);
  assert.deepEqual(
    ids,
    ["spec", "plan", "adr-ADR-001", "task-001", "task-002", "task-003"],
    "spec/plan/adr THEN a task-<NNN> doc per task, keys mirroring buildDocIndex's ids",
  );
});

test("read ferries each task as a task-<NNN> doc carrying its frontmatter + body", () => {
  const reader = new WorkReader(fakeRepo(sampleFiles()), fixedClock);
  const result = reader.read("sample");
  assert.ok(result, "the run reads");
  const task002 = result.docs.find((d) => d.id === "task-002");
  assert.ok(task002, "GET /doc/task-002 now resolves — the task doc is present");
  assert.equal(task002.body, "task 2 body", "the task's body is ferried");
  // The lock is derived at the transport edge from the ferried frontmatter (status + lockedBy): an
  // in-progress task is locked by its `lockedBy`. Proving the lock-driving fields reach the reader doc.
  assert.equal(task002.frontmatter.status, "in-progress", "the in-progress status reaches the doc");
  assert.equal(task002.frontmatter.lockedBy, "implementer", "the lock holder reaches the doc");

  // A done task ferries no lock signal — its status drives `lock: null` at the edge (it's editable).
  const task001 = result.docs.find((d) => d.id === "task-001");
  assert.ok(task001, "the done task doc is present too");
  assert.equal(task001.frontmatter.status, "done", "a done task carries no in-progress lock");
});

test("read falls back to the run id for the title when no plan/spec title exists", () => {
  const files = sampleFiles();
  files.plan = null;
  files.spec = null;
  const reader = new WorkReader(fakeRepo(files), fixedClock);
  const result = reader.read("sample");
  assert.equal(result?.summary.title, "sample");
});

test("read returns undefined for an absent run", () => {
  const reader = new WorkReader(fakeRepo(sampleFiles()), fixedClock);
  assert.equal(reader.read("missing"), undefined);
});

test("read on the REAL fixture run returns a populated summary + doc index (acceptance)", () => {
  const cwd = loadFixtureRun();
  try {
    const reader = new WorkReader(new FsWorkRepository(cwd), fixedClock);
    const result = reader.read(FIXTURE_RUN);
    assert.ok(result, "the fixture run reads");

    // Summary: tasks tallied, every bucket present, a real title, the clock stamp.
    const total =
      result.summary.taskCounts.todo +
      result.summary.taskCounts["in-progress"] +
      result.summary.taskCounts["in-review"] +
      result.summary.taskCounts.done;
    assert.ok(total > 0, "the fixture has tasks tallied into the summary");
    assert.ok(result.summary.title.length > 0, "a non-empty title");

    // Doc index: an entry per real artifact on disk, with FLOW's status carried through.
    assert.ok(
      result.docIndex.some((d) => d.id === "spec"),
      "the spec from disk",
    );
    assert.ok(
      result.docIndex.some((d) => d.id.startsWith("task-")),
      "a task from disk",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── the run's own age (phase 1 screenshot pass) ────────────────────────────────────────────────────
// `updatedAt` used to be `clock.now()`, so every board card claimed it had changed "just now" no matter
// when the run last moved. A relative age that is always "just now" is not a missing fact, it is a false
// one — and the board leans on it in four columns.
test("updatedAt is the run's OWN last change when the repository can tell us", () => {
  const files = sampleFiles();
  const repo = {
    listRuns: () => [files.run],
    readRun: () => files,
    lastModified: () => "2026-08-01T10:00:00.000Z",
  };
  const read = new WorkReader(repo, fixedClock).read(files.run);
  assert.equal(read?.summary.updatedAt, "2026-08-01T10:00:00.000Z");
});

test("it falls back to the clock only when the repository cannot say", () => {
  const files = sampleFiles();
  const repo = { listRuns: () => [files.run], readRun: () => files };
  const read = new WorkReader(repo, fixedClock).read(files.run);
  assert.equal(read?.summary.updatedAt, fixedClock.now());
});
