// Tests for the deterministic grader (T-006, ADR-001). ZERO API spend — no `claude -p` ever runs; the grader
// is pure filesystem/process inspection of a produced tree against a declared hidden suite.
//
// Coverage maps to the task's Acceptance 1–4:
//   AC11 (#1): grade() on an empty/no-op tree → passed: 0, BY CONSTRUCTION.
//   AC10 (#2): the sample grader/ content is absent from the "sandbox" produced tree (grep proves no leak).
//   AC15 (#3): perAc[] carries per-check pass/fail + evidence; a partial tree grades met/total < total.
//   AC8  (#4): lessonReuse derives a yes/no + evidence from RunRecord.usedMemories (and the gotcha-avoided path).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runCheck } from "../src/grader/check.ts";
import { loadGraderFixture } from "../src/grader/fixture.ts";
import { grade, lessonReuse } from "../src/grader/runner.ts";
import type { LessonDecl } from "../src/grader/runner.ts";
import type { RunRecord } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(HERE, "fixtures", "grader-sample");
const SAMPLE_GRADER = join(SAMPLE, "grader");
const SAMPLE_PRODUCED = join(SAMPLE, "produced");

/** Walk a dir tree, returning every file's relative path (for the AC10 leak grep). */
function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = entry.name;
    if (entry.isDirectory()) {
      for (const child of listFiles(join(root, rel))) out.push(join(rel, child));
    } else {
      out.push(rel);
    }
  }
  return out;
}

// --- AC11 (#1): empty/no-op tree → 0% BY CONSTRUCTION -----------------------

test("grade() on an empty tree returns passed: 0 (AC11, by construction)", () => {
  const suite = loadGraderFixture(SAMPLE_GRADER);
  const empty = mkdtempSync(join(tmpdir(), "grader-empty-"));
  try {
    const result = grade(empty, suite);
    assert.equal(result.passed, 0, "no check may pass on an empty produced tree");
    assert.equal(result.total, suite.checks.length, "total is the full set size regardless of passes");
    assert.ok(result.total > 0, "the sample suite must declare checks for this to be meaningful");
    assert.ok(result.perAc.every((r) => !r.passed), "every per-check entry must be a fail");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("grade() on a NON-EXISTENT tree path also scores 0 (absence cannot pass)", () => {
  const suite = loadGraderFixture(SAMPLE_GRADER);
  const result = grade(join(tmpdir(), "grader-does-not-exist-xyz"), suite);
  assert.equal(result.passed, 0);
});

test("a missing file makes its check FAIL, never pass (the gameable-bug guard)", () => {
  const result = runCheck({ id: "x", kind: "file_exists", path: "nope.ts" }, mkdtempSync(join(tmpdir(), "g-")));
  assert.equal(result.passed, false);
  assert.match(result.evidence, /ABSENT/);
});

// --- AC10 (#2): the hidden suite never leaks into the produced/sandbox tree ----

test("sample grader/ content is ABSENT from the produced (sandbox) tree (AC10)", () => {
  // The grader/ dir is a SIBLING of produced/; nothing under produced/ may carry the suite's check content.
  const producedFiles = listFiles(SAMPLE_PRODUCED);
  assert.ok(producedFiles.length > 0, "the sample must ship a produced tree to grade");
  assert.ok(
    producedFiles.every((f) => !f.includes("checks.json")),
    "checks.json must not appear in the produced tree",
  );
  // Grep every produced file for any check id from the hidden suite — none may leak.
  const suite = loadGraderFixture(SAMPLE_GRADER);
  const ids = suite.checks.map((c) => c.id);
  for (const rel of producedFiles) {
    const content = readFileSync(join(SAMPLE_PRODUCED, rel), "utf8");
    for (const id of ids) {
      assert.ok(!content.includes(id), `check id "${id}" leaked into produced/${rel}`);
    }
  }
});

// --- AC15 (#3): perAc[] per-check pass/fail + evidence; partial tree → met/total ----

test("grade() returns perAc[] with per-check pass/fail + evidence (AC15 met/total)", () => {
  const suite = loadGraderFixture(SAMPLE_GRADER);
  const result = grade(SAMPLE_PRODUCED, suite);

  // The produced tree has index.ts (with `export function run` and `return`) but no util.ts → partial.
  assert.equal(result.total, 4);
  assert.equal(result.passed, 3, "3 of 4 checks met (util.ts absent)");

  const byId = new Map(result.perAc.map((r) => [r.id, r]));
  assert.equal(byId.get("AC1-entry-exists")!.passed, true);
  assert.equal(byId.get("AC2-exports-run")!.passed, true);
  assert.equal(byId.get("AC3-util-exists")!.passed, false);
  assert.equal(byId.get("AC4-no-todo-left")!.passed, true);

  // Every entry carries auditable evidence (the assertion that ran).
  for (const r of result.perAc) {
    assert.ok(r.evidence.length > 0, `${r.id} must record evidence`);
  }
  assert.match(byId.get("AC3-util-exists")!.evidence, /ABSENT/);
});

test("a command check scores on exit code and fails when un-spawnable", () => {
  const dir = mkdtempSync(join(tmpdir(), "g-cmd-"));
  try {
    const ok = runCheck({ id: "ok", kind: "command", cmd: ["node", "-e", "process.exit(0)"] }, dir);
    assert.equal(ok.passed, true);
    const bad = runCheck({ id: "bad", kind: "command", cmd: ["node", "-e", "process.exit(3)"] }, dir);
    assert.equal(bad.passed, false);
    const missing = runCheck({ id: "missing", kind: "command", cmd: ["definitely-not-a-real-binary-xyz"] }, dir);
    assert.equal(missing.passed, false, "an un-spawnable command is a FAIL, never a pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- AC8 (#4): lessonReuse from observed output ------------------------------

test("lessonReuse returns reused:true + evidence when usedMemories contains the lesson id (AC8)", () => {
  const record: RunRecord = {
    cost: zeroCost(),
    producedTree: ["src/index.ts"],
    usedMemories: ["fact:date-formatter-drops-tz"],
    raw: null,
  };
  const decl: LessonDecl = { lessonId: "fact:date-formatter-drops-tz" };
  const signal = lessonReuse(record, decl);
  assert.equal(signal.reused, true);
  assert.equal(signal.lessonId, decl.lessonId);
  assert.match(signal.evidence, /used_memories contains/);
});

test("lessonReuse returns reused:false + evidence when the lesson id is absent", () => {
  const record: RunRecord = {
    cost: zeroCost(),
    producedTree: [],
    usedMemories: ["some:other:fact"],
    raw: null,
  };
  const signal = lessonReuse(record, { lessonId: "fact:date-formatter-drops-tz" });
  assert.equal(signal.reused, false);
  assert.match(signal.evidence, /does not contain/);
});

test("lessonReuse falls back to the gotcha-avoided probe against the produced tree", () => {
  // No used_memories hit, but the warm run AVOIDED the cold-only gotcha (pattern absent from index.ts).
  const record: RunRecord = { cost: zeroCost(), producedTree: ["src/index.ts"], usedMemories: [], raw: null };
  const decl: LessonDecl = {
    lessonId: "lesson:no-naive-tz",
    avoidedGotcha: { treePath: "src/index.ts", pattern: "new Date\\(\\)\\.toISOString" },
  };
  const avoided = lessonReuse(record, decl, SAMPLE_PRODUCED);
  assert.equal(avoided.reused, true, "gotcha pattern absent → lesson reused");
  assert.match(avoided.evidence, /gotcha avoided/);

  // And when the gotcha IS present, reuse is false.
  const notAvoided = lessonReuse(
    record,
    { lessonId: "lesson:has-return", avoidedGotcha: { treePath: "src/index.ts", pattern: "return" } },
    SAMPLE_PRODUCED,
  );
  assert.equal(notAvoided.reused, false, "gotcha pattern present → not reused");
  assert.match(notAvoided.evidence, /gotcha PRESENT/);
});

function zeroCost(): RunRecord["cost"] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    numTurns: 0,
    totalCostUsd: 0,
    durationMs: 0,
  };
}
