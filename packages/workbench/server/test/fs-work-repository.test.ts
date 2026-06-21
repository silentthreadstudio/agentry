// FsWorkRepository proof — the file→read-model parser (task 008). Asserts on the observable `RunFiles`
// parsed from a REAL run dir on disk, so the test exercises the actual FLOW on-disk shapes (the two-block
// task file, the `routing-decision` event line, real adrs), not an invented fixture. The run is a committed
// fixture (`fixtures/work-fixture/<RUN_ID>/`) copied into a temp `.agentry/work/` tree per the loader, so it
// is CI-portable (the live `.agentry/work/` is gitignored and absent on a clean checkout). Read-only: it
// never writes to the watched tree.
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FsWorkRepository } from "../src/persistence/fs-work-repository.js";
import { FIXTURE_RUN, FIXTURE_RUN_DIR, loadFixtureRun } from "./fixtures/load-fixture-run.js";

// Build a repository over a fresh temp project root carrying the committed fixture run, plus its cleanup.
function withFixtureRepo(): { repo: FsWorkRepository; cwd: string; cleanup: () => void } {
  const cwd = loadFixtureRun();
  return {
    repo: new FsWorkRepository(cwd),
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

test("listRuns lists every .agentry/work/* run, including the fixture", () => {
  const { repo, cleanup } = withFixtureRepo();
  try {
    const runs = repo.listRuns();
    assert.ok(runs.length > 0, "at least one run present");
    assert.ok(runs.includes(FIXTURE_RUN), "the fixture run is listed");
    // Sorted + de-duplicated dir names only — no stray non-run entries leak in as empty strings.
    assert.ok(
      runs.every((r) => typeof r === "string" && r.length > 0),
      "every run id is a non-empty folder name",
    );
  } finally {
    cleanup();
  }
});

test("readRun parses a run dir into RunFiles matching FLOW's on-disk shapes", () => {
  const { repo, cleanup } = withFixtureRepo();
  try {
    const files = repo.readRun(FIXTURE_RUN);
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
  } finally {
    cleanup();
  }
});

test("readRun merges the task-meta block so buildGraph's fields (deps/status) are on frontmatter", () => {
  const { repo, cleanup } = withFixtureRepo();
  try {
    const files = repo.readRun(FIXTURE_RUN);
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
  } finally {
    cleanup();
  }
});

test("readRun returns undefined for an absent run", () => {
  const { repo, cleanup } = withFixtureRepo();
  try {
    assert.equal(repo.readRun("no-such-run-xyz"), undefined);
  } finally {
    cleanup();
  }
});

test("listRuns returns [] when the work root is absent", () => {
  // A cwd with no .agentry/work — listRuns must not throw, just report nothing. The fixtures dir itself
  // has no `.agentry/work/`, so it stands in as an empty project root.
  const empty = new FsWorkRepository(join(FIXTURE_RUN_DIR, ".."));
  assert.deepEqual(empty.listRuns(), []);
});

// Guard: the committed fixture run dir must exist on disk (tracked, NOT under `.agentry`) for these
// assertions to mean anything. This is the precondition that fails loudly if the fixture is lost.
test("the committed fixture run dir exists on disk (test precondition)", () => {
  assert.ok(existsSync(FIXTURE_RUN_DIR), "fixture run dir present");
});
