// FsWorkRepository proof — the file→read-model parser (task 008). Asserts on the observable `RunFiles`
// parsed from a REAL run dir on disk (THIS run's `.agentry/work/<run>/`), so the test exercises the
// actual FLOW on-disk shapes (the two-block task file, the `routing-decision` event line, real adrs),
// not an invented fixture. Read-only: it never writes to the watched tree.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FsWorkRepository } from "../src/persistence/fs-work-repository.js";

// The repo root = four levels up from this test file (packages/workbench/server/test → repo root).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
// THIS run — the fixture the task points at (a decompose+verify run with spec/plan/adr/tasks).
const FIXTURE_RUN = "build-agentry-workbench-the-agentry-agent-center-5s9v6deiit";

function repo(): FsWorkRepository {
  return new FsWorkRepository(REPO_ROOT);
}

test("listRuns lists every .agentry/work/* run, including the fixture", () => {
  const runs = repo().listRuns();
  assert.ok(runs.length > 0, "at least one run present");
  assert.ok(runs.includes(FIXTURE_RUN), "the fixture run is listed");
  // Sorted + de-duplicated dir names only — no stray non-run entries leak in as empty strings.
  assert.ok(
    runs.every((r) => typeof r === "string" && r.length > 0),
    "every run id is a non-empty folder name",
  );
});

test("readRun parses a run dir into RunFiles matching FLOW's on-disk shapes", () => {
  const files = repo().readRun(FIXTURE_RUN);
  assert.ok(files, "the fixture run parses");
  assert.equal(files.run, FIXTURE_RUN);

  // routing: lifted from the first routing-decision line of events.jsonl (the graph root).
  assert.deepEqual(files.routing, { shape: "decompose+verify", kind: "feature" });

  // spec/plan: frontmatter + body via FLOW's FRONTMATTER regex (frontmatter, not stripped to body).
  assert.ok(files.spec, "spec parsed");
  assert.equal(files.spec.frontmatter.kind, "spec");
  assert.ok(files.plan, "plan parsed");
  assert.equal(typeof files.plan.frontmatter.title, "string");

  // adrs: each id-keyed via its own frontmatter `id` (ADR-001 carries id "ADR-001").
  assert.ok(files.adrs.length >= 1, "adrs parsed");
  assert.ok(
    files.adrs.some((a) => a.frontmatter.id === "ADR-001"),
    "ADR-001 present with its frontmatter id",
  );
});

test("readRun merges the task-meta block so buildGraph's fields (deps/status) are on frontmatter", () => {
  const files = repo().readRun(FIXTURE_RUN);
  assert.ok(files, "the fixture run parses");

  // The lifecycle block gives `status`/`title`; the lifted meta block gives `deps` — both must land on
  // ONE frontmatter for buildGraph. Task 009 depends on [6, 7, 8] (bare integers, surfaced faithfully).
  const t9 = files.tasks.find((t) => t.taskNo === "009");
  assert.ok(t9, "task 009 present");
  assert.equal(typeof t9.frontmatter.status, "string", "status from the lifecycle block");
  assert.deepEqual(t9.frontmatter.deps, [6, 7, 8], "deps from the lifted meta block, as bare integers");

  // Lifecycle wins a key clash: `status` is authored in both blocks — FLOW's lifecycle value is truth.
  const t1 = files.tasks.find((t) => t.taskNo === "001");
  assert.ok(t1, "task 001 present");
  assert.equal(t1.frontmatter.status, "done", "task 001 lifecycle status is done");
});

test("readRun returns undefined for an absent run", () => {
  assert.equal(repo().readRun("no-such-run-xyz"), undefined);
});

test("listRuns returns [] when the work root is absent", () => {
  // A cwd with no .agentry/work — listRuns must not throw, just report nothing.
  const empty = new FsWorkRepository(join(REPO_ROOT, "packages", "workbench", "server", "test"));
  assert.deepEqual(empty.listRuns(), []);
});

// Guard: the fixture run dir must exist for these assertions to mean anything.
test("the fixture run dir exists on disk (test precondition)", () => {
  assert.ok(
    existsSync(join(REPO_ROOT, ".agentry", "work", FIXTURE_RUN)),
    "fixture run dir present",
  );
});
