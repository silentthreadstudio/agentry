// Tests for the pure-ish shape-extractor (autopilot-design §2 / AC2). ZERO API spend: every case runs
// `extractShape` over a SYNTHETIC `.agentry/work/*` layout built in a temp working dir (no `claude -p`, no
// runner) plus the `ctx` settle signals. These prove the artifact→shape mapping, the one-shot-vs-degenerate
// disambiguation, and tolerance of a missing `.agentry/` — the faithful mechanism that replaced the
// proven-invalid subagent-dispatch proxy.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DegenerateRunError, extractShape } from "../src/routing/extract.ts";

/** A fresh temp working dir (the sandbox root the extractor scans for `.agentry/work/*`). */
function freshWorkingDir(): string {
  return mkdtempSync(join(tmpdir(), "selfeval-extract-work-"));
}

/** Create `<workingDir>/.agentry/work/<slug>/` and return its absolute path. */
function workSlugDir(workingDir: string, slug: string): string {
  const dir = join(workingDir, ".agentry", "work", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- decompose: a plan.md, and/or a non-empty tasks/ ---------------------------------------------------

test("a plan.md in a work folder => decompose", () => {
  const wd = freshWorkingDir();
  writeFileSync(join(workSlugDir(wd, "feature-x"), "plan.md"), "# plan\n", "utf8");

  assert.equal(extractShape(wd, { producedTreeNonEmpty: true }), "decompose");
});

test("a non-empty tasks/ dir (no plan.md) => decompose", () => {
  const wd = freshWorkingDir();
  const slug = workSlugDir(wd, "feature-x");
  const tasks = join(slug, "tasks");
  mkdirSync(tasks, { recursive: true });
  writeFileSync(join(tasks, "001-thing.md"), "# task\n", "utf8");

  assert.equal(extractShape(wd, { producedTreeNonEmpty: true }), "decompose");
});

test("decompose wins over a spec.md present in the same work folder (heaviest shape wins)", () => {
  const wd = freshWorkingDir();
  const slug = workSlugDir(wd, "feature-x");
  writeFileSync(join(slug, "spec.md"), "# spec\n", "utf8");
  writeFileSync(join(slug, "plan.md"), "# plan\n", "utf8");

  assert.equal(extractShape(wd, { producedTreeNonEmpty: true }), "decompose");
});

// --- spec-first: a spec.md only ------------------------------------------------------------------------

test("a spec.md only (no plan.md, empty/absent tasks/) => spec-first", () => {
  const wd = freshWorkingDir();
  writeFileSync(join(workSlugDir(wd, "feature-x"), "spec.md"), "# spec\n", "utf8");

  assert.equal(extractShape(wd, { producedTreeNonEmpty: true }), "spec-first");
});

test("a spec.md with an EMPTY tasks/ dir => spec-first (empty tasks does not force decompose)", () => {
  const wd = freshWorkingDir();
  const slug = workSlugDir(wd, "feature-x");
  writeFileSync(join(slug, "spec.md"), "# spec\n", "utf8");
  mkdirSync(join(slug, "tasks"), { recursive: true }); // empty

  assert.equal(extractShape(wd, { producedTreeNonEmpty: true }), "spec-first");
});

// --- one-shot: no work-folder artifacts + clean settle + produced output -------------------------------

test("no work-folder artifacts + settled success + produced output => one-shot", () => {
  const wd = freshWorkingDir(); // no .agentry/ at all
  assert.equal(
    extractShape(wd, { resultSubtype: "success", producedTreeNonEmpty: true }),
    "one-shot",
  );
});

test("an empty work folder (no spec/plan/tasks) + settled success + produced output => one-shot", () => {
  const wd = freshWorkingDir();
  workSlugDir(wd, "feature-x"); // a work slug dir exists but holds no spec/plan/tasks artifacts
  assert.equal(
    extractShape(wd, { resultSubtype: "success", producedTreeNonEmpty: true }),
    "one-shot",
  );
});

// --- degenerate: no artifacts AND not a clean settle => throws, never one-shot --------------------------

test("no artifacts + no settled result (aborted/killed) => DegenerateRunError, not one-shot", () => {
  const wd = freshWorkingDir();
  assert.throws(() => extractShape(wd, { producedTreeNonEmpty: false }), DegenerateRunError);
});

test("no artifacts + settled non-success => DegenerateRunError, not one-shot", () => {
  const wd = freshWorkingDir();
  assert.throws(
    () => extractShape(wd, { resultSubtype: "error_during_execution", producedTreeNonEmpty: true }),
    DegenerateRunError,
  );
});

test("no artifacts + settled success but EMPTY produced tree => DegenerateRunError, not one-shot", () => {
  const wd = freshWorkingDir();
  assert.throws(
    () => extractShape(wd, { resultSubtype: "success", producedTreeNonEmpty: false }),
    DegenerateRunError,
  );
});

// --- robustness: a missing .agentry/ is tolerated (no artifacts), not fatal ----------------------------

test("a working dir with no .agentry/ at all falls to the settle-signal path, never throws on the scan", () => {
  const wd = freshWorkingDir();
  // success + produced tree => one-shot (proves the scan tolerated the absent .agentry/ rather than crashing).
  assert.equal(extractShape(wd, { resultSubtype: "success", producedTreeNonEmpty: true }), "one-shot");
});
