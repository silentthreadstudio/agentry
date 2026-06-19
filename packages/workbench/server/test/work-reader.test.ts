// WorkReader proof — the application fold (task 008). Two layers of evidence:
//  1. against a FAKE WorkRepository, so the fold (summary tally, title, docs, graph delegation) is
//     tested deterministically with no fs — the port purity ADR-001 buys.
//  2. against the REAL FsWorkRepository on the fixture run, so `read` is proven to return a populated
//     `RunSummary` + `GraphModel` for genuine on-disk data (the acceptance).
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Clock, RunFiles, WorkRepository } from "../src/domain/ports.js";
import { FsWorkRepository } from "../src/persistence/fs-work-repository.js";
import { WorkReader } from "../src/application/work-reader.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FIXTURE_RUN = "build-agentry-workbench-the-agentry-agent-center-5s9v6deiit";

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
      { taskNo: "002", frontmatter: { title: "b", status: "in-progress", deps: [1] }, body: "" },
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
  assert.equal(result.summary.updatedAt, "2026-06-19T00:00:00.000Z", "updatedAt from the injected clock");
  // 001 done, 002 in-progress, 003 status-less → todo; every bucket present even at 0.
  assert.deepEqual(result.summary.taskCounts, { todo: 1, "in-progress": 1, "in-review": 0, done: 1 });
});

test("read returns a GraphModel derived from the same files (buildGraph delegation)", () => {
  const reader = new WorkReader(fakeRepo(sampleFiles()), fixedClock);
  const result = reader.read("sample");
  assert.ok(result, "the run reads");
  // The graph carries the routing root + a node per task — proof buildGraph ran on these files.
  assert.ok(result.graph.nodes.some((n) => n.id === "routing"), "routing root node");
  assert.ok(result.graph.nodes.some((n) => n.id === "task-002"), "a task node");
  assert.ok(result.graph.edges.length > 0, "edges derived");
});

test("read ferries docs keyed with buildGraph's node ids", () => {
  const reader = new WorkReader(fakeRepo(sampleFiles()), fixedClock);
  const result = reader.read("sample");
  assert.ok(result, "the run reads");
  const ids = result.docs.map((d) => d.id);
  assert.deepEqual(ids, ["spec", "plan", "adr-ADR-001"], "spec/plan/adr docs, adr keyed by its id");
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

test("read on the REAL fixture run returns a populated summary + graph (acceptance)", () => {
  const reader = new WorkReader(new FsWorkRepository(REPO_ROOT), fixedClock);
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

  // Graph: the routing root + dependency edges (proof the merged deps reach buildGraph on real files).
  assert.ok(result.graph.nodes.some((n) => n.id === "routing"), "routing root from events.jsonl");
  assert.ok(result.graph.edges.some((e) => e.kind === "depends-on"), "depends-on edges from merged deps");
});
