// Pre-registered moat Δ target `W` (AC-THRESH / ADR-001 §thresholds) — ZERO API spend. The falsifiable TARGET is
// written before any run in the tracked `thresholds.json`; the moat probe's `successCondition` reads it and NEVER
// carries a bare `threshold: null` on the public path. These tests exercise the exposed pure pieces directly
// (`loadMoatThreshold` over a fixture thresholds file + the committed one; `buildMoatSuccessCondition` over the
// calibrated / uncalibrated / aborted cases) — the load-bearing W logic, with no live probe run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  loadMoatThreshold,
  buildMoatSuccessCondition,
  type MoatThreshold,
} from "../src/moat/probe.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The committed, tracked pre-registration source this task creates. */
const COMMITTED_THRESHOLDS = join(HERE, "..", "thresholds.json");

/** Write a throwaway thresholds.json with the given `moat` block and return its path (no committed-file mutation). */
function writeThresholds(moat: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "moat-thresh-"));
  const path = join(dir, "thresholds.json");
  writeFileSync(path, JSON.stringify({ moat }), "utf8");
  return path;
}

// --- the committed pre-registration source -----------------------------------------------------------------------

test("committed thresholds.json carries a NON-NULL pre-registered moat target W", () => {
  const raw = JSON.parse(readFileSync(COMMITTED_THRESHOLDS, "utf8")) as { moat?: { W?: unknown }; rightsizing?: unknown };
  // The W entry exists and is non-null (the falsifiable FORM is on record before any run — AC-THRESH).
  assert.notEqual(raw.moat?.W, undefined);
  assert.notEqual(raw.moat?.W, null);
  // Disjoint-keys discipline: `moat`/`W` and T-02's `rightsizing`/`X` coexist as separate top-level keys (the
  // end-state once both pre-registrations land); neither clobbers the other.
  assert.notEqual((raw as { rightsizing?: { X?: unknown } }).rightsizing?.X, undefined);
});

test("loadMoatThreshold reads the committed moat.W with the falsifiable form, calibration pending", () => {
  const w = loadMoatThreshold(COMMITTED_THRESHOLDS);
  assert.equal(typeof w.statement, "string");
  assert.ok(w.statement.length > 0);
  assert.equal(w.metric, "discrimination");
  // The NUMBER is deliberately uncalibrated: the owner sets it from the first run, never invented in advance.
  assert.equal(w.delta, null);
  assert.equal(w.calibrationPending, true);
});

test("loadMoatThreshold throws when the falsifiable target is absent (public path may not silently default)", () => {
  const noW = writeThresholds({});
  assert.throws(() => loadMoatThreshold(noW), /moat target/);
});

// --- the public-path success condition (never a bare null) --------------------------------------------------------

const PENDING_TARGET: MoatThreshold = {
  statement: "discrimination ≥ W",
  metric: "discrimination",
  delta: null,
  calibrationPending: true,
};
const CALIBRATED_TARGET: MoatThreshold = {
  statement: "discrimination ≥ 0.5",
  metric: "discrimination",
  delta: 0.5,
  calibrationPending: false,
};

test("successCondition carries the non-null target — NEVER a bare null threshold (AC-THRESH)", () => {
  const sc = buildMoatSuccessCondition(PENDING_TARGET, 0.4);
  // The target is always present and non-null; this is the public-path guarantee against `threshold: null`.
  assert.notEqual(sc.target, null);
  assert.equal(sc.target.statement, PENDING_TARGET.statement);
});

test("uncalibrated W ⇒ pending, target on record, NO pass/fail against a number that does not exist yet", () => {
  const sc = buildMoatSuccessCondition(PENDING_TARGET, 0.42);
  assert.equal(sc.calibrationPending, true);
  assert.equal(sc.observed, 0.42);
  assert.equal(sc.pass, undefined); // no pass/fail without a calibrated delta
});

test("calibrated W cleared ⇒ pass true (measured discrimination ≥ W)", () => {
  const sc = buildMoatSuccessCondition(CALIBRATED_TARGET, 0.6);
  assert.equal(sc.calibrationPending, false);
  assert.equal(sc.observed, 0.6);
  assert.equal(sc.pass, true);
});

test("calibrated W missed ⇒ pass false (the honest delta is below W)", () => {
  const sc = buildMoatSuccessCondition(CALIBRATED_TARGET, 0.4);
  assert.equal(sc.pass, false);
});

test("calibrated W met exactly at the boundary ⇒ pass true (≥ is inclusive)", () => {
  const sc = buildMoatSuccessCondition(CALIBRATED_TARGET, 0.5);
  assert.equal(sc.pass, true);
});

test("aborted run (no number) ⇒ observed null, NO pass/fail, but the target STILL ships", () => {
  // A gate fired upstream ⇒ no discrimination number. The pre-registered target is still on the public path.
  const sc = buildMoatSuccessCondition(CALIBRATED_TARGET, null);
  assert.equal(sc.observed, null);
  assert.equal(sc.pass, undefined);
  assert.notEqual(sc.target, null);
});
