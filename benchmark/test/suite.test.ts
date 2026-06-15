// Tests for the suite loader + fixture manifest (T-007 M1). ZERO API spend — no `claude -p` ever runs; this
// is pure filesystem enumeration + YAML parse over the committed fixtures.
//
// Coverage maps to the task's Acceptance 1–4:
//   AC1: loadSuite over the shipped fixtures covers R0/R1/R1prime/R2/R3, and THROWS on a missing regime or a
//        task lacking grader/ (AC14).
//   AC2: every fixture task has a sibling grader/ located OUTSIDE the sandbox tree (structural — grader/ is a
//        sibling of task.yaml, never under a produced/working tree).
//   AC3: the R2 fixture's grader/ is a SET of ≥2 checks (AC15 met/total is meaningful).
//   AC4: the R3 pair cross-references by id and the follow-up names a LessonDecl (AC8).
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadGraderFixture } from "../src/grader/fixture.ts";
import { parseManifest } from "../src/suite/manifest.ts";
import { loadSuite, REQUIRED_REGIMES } from "../src/suite/loader.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");

/** Copy the shipped fixtures into a temp dir so destructive cases (delete a regime) can't touch the source. */
function cloneFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "suite-fix-"));
  cpSync(FIXTURES, dir, { recursive: true });
  return dir;
}

// --- AC1: every regime present + the four-arm coverage --------------------------

test("loadSuite covers R0, R1, R1prime, R2, and the R3 pair (AC14 enumeration)", () => {
  const tasks = loadSuite(FIXTURES);
  const regimes = new Set(tasks.map((t) => t.manifest.regime));
  for (const required of REQUIRED_REGIMES) {
    assert.ok(regimes.has(required), `suite must cover regime ${required}`);
  }
  // R3 ships as a PAIR (teacher + follow-up) — two R3 tasks.
  assert.equal(tasks.filter((t) => t.manifest.regime === "R3").length, 2, "R3 is a teacher→follow-up pair");
});

test("loadSuite THROWS when a required regime is absent (AC14 is an assertion, not a hope)", () => {
  const dir = cloneFixtures();
  try {
    rmSync(join(dir, "r0-greeter"), { recursive: true, force: true }); // drop the only R0 task
    assert.throws(() => loadSuite(dir), /missing required regime/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSuite THROWS when a task lacks a grader/ dir (every task needs a hidden suite — AC14)", () => {
  const dir = cloneFixtures();
  try {
    rmSync(join(dir, "r0-greeter", "grader"), { recursive: true, force: true });
    assert.throws(() => loadSuite(dir), /no grader\/ dir/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSuite skips non-fixture dirs (warm-snapshot/ has no task.yaml → not a task)", () => {
  // warm-snapshot/ lives under fixtures/ but is not a task; it must be ignored, not throw.
  const tasks = loadSuite(FIXTURES);
  assert.ok(!tasks.some((t) => t.fixtureDir.endsWith("warm-snapshot")), "warm-snapshot is not a task");
});

// --- AC2: every task has a sibling grader/ located outside any sandbox tree -----

test("every fixture task has a sibling grader/ and its checks.json parses (AC10 structural)", () => {
  const tasks = loadSuite(FIXTURES);
  for (const task of tasks) {
    // grader/ is a SIBLING of task.yaml inside the fixture dir — never under a produced/working tree.
    assert.equal(task.graderDir, join(task.fixtureDir, "grader"), `${task.manifest.id} grader/ must be a sibling`);
    const fixture = loadGraderFixture(task.graderDir);
    assert.ok(fixture.checks.length > 0, `${task.manifest.id} must declare at least one check`);
  }
});

// --- AC3: the R2 fixture's grader/ is a SET of >= 2 checks ----------------------

test("the R2 fixture's hidden suite is a set of >= 2 checks (AC15 met/total)", () => {
  const tasks = loadSuite(FIXTURES);
  const r2 = tasks.find((t) => t.manifest.regime === "R2");
  assert.ok(r2, "an R2 fixture must exist");
  const fixture = loadGraderFixture(r2!.graderDir);
  assert.ok(fixture.checks.length >= 2, `R2 must declare >= 2 checks, got ${fixture.checks.length}`);
});

// --- AC4: the R3 pair cross-refs by id + follow-up names a LessonDecl (AC8) -----

test("the R3 pair cross-references by id and the follow-up names a LessonDecl (AC8)", () => {
  const tasks = loadSuite(FIXTURES);
  const r3 = tasks.filter((t) => t.manifest.regime === "R3");
  const followUp = r3.find((t) => t.manifest.lesson !== undefined);
  const teacher = r3.find((t) => t.manifest.lesson === undefined);
  assert.ok(followUp, "the R3 follow-up must name a lesson");
  assert.ok(teacher, "the R3 teacher must exist");

  // Cross-reference by id, both directions resolvable within the suite.
  assert.equal(followUp!.manifest.pair, teacher!.manifest.id, "follow-up pairs with the teacher by id");
  assert.equal(teacher!.manifest.pair, followUp!.manifest.id, "teacher pairs back with the follow-up by id");
  assert.ok(followUp!.manifest.deps?.includes(teacher!.manifest.id), "follow-up depends on the teacher (ordering)");

  // The LessonDecl is well-formed (matches T-006's lessonReuse input).
  const lesson = followUp!.manifest.lesson!;
  assert.ok(lesson.lessonId.length > 0, "lessonId must be present");
  assert.ok(lesson.avoidedGotcha, "the seed follow-up declares a gotcha-avoided probe");
  assert.ok(lesson.avoidedGotcha!.treePath.length > 0);
  assert.ok(lesson.avoidedGotcha!.pattern.length > 0);
});

// --- manifest parse: validation edges -------------------------------------------

test("parseManifest rejects an unknown regime", () => {
  assert.throws(() => parseManifest("id: x\nregime: RX\narmEligibility: [A]\nprompt: hi\n", "x"), /not one of/);
});

test("parseManifest requires exactly one of prompt | promptFile", () => {
  assert.throws(
    () => parseManifest("id: x\nregime: R0\narmEligibility: [A]\n", "x"),
    /exactly one of/,
  );
  assert.throws(
    () => parseManifest("id: x\nregime: R0\narmEligibility: [A]\nprompt: hi\npromptFile: p.txt\n", "x"),
    /exactly one of/,
  );
});

test("parseManifest accepts the legacy arm-eligibility spelling", () => {
  const m = parseManifest("id: x\nregime: R0\narm-eligibility: [A, B]\nprompt: hi\n", "x");
  assert.deepEqual(m.armEligibility, ["A", "B"]);
});

test("loadSuite THROWS when a manifest id does not match its dir name", () => {
  const dir = cloneFixtures();
  try {
    writeFileSync(
      join(dir, "r0-greeter", "task.yaml"),
      "id: wrong-id\nregime: R0\narmEligibility: [A]\nprompt: hi\n",
    );
    assert.throws(() => loadSuite(dir), /id must match dir name/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
