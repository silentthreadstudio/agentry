// Pure-core tests for the results-gated rightsizing scorer (ADR-001) — the correctness HEART of the bench, with
// ZERO spend: the win/tax/miss/indeterminate bucketing, the determinate-vs-total denominators, the trap cases, the
// pre-registered X success condition (form + pass/fail boundary), and the aborted (gate-fired) discriminator.
// Synthetic records only; no fs double for records, no spawn — the purity claim is proven by constructing records by
// hand. A temp `thresholds.json` fixture drives the calibrated-X pass/fail boundary without touching the tracked file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildScoredArtifact,
  buildAbortedArtifact,
  loadRightsizingThreshold,
  RESULT_GOOD_THRESHOLD,
  RIGHTSIZING_SUCCESS_THRESHOLD,
  type RightsizingRunRecord,
} from "../src/rightsizing/score.ts";
import type { Score } from "../src/judge/index.ts";
import type { Shape } from "../src/conduct/shape.ts";

// --- helpers -----------------------------------------------------------------------------------------------------

/** A judged score with a given overall (dimensions illustrative; the scorer reads only `overall`). */
function score(overall: number): Score {
  return { dimensions: { meetsIntent: 2, correct: 2, soundCode: 2, complete: 2 }, overall, rationale: "" };
}

const GOOD = score(1); // clears the 0.5 bar
const BAD = score(0); // below the bar

/** Build a record with sensible defaults, overriding only what a case cares about. */
function rec(over: Partial<RightsizingRunRecord> & Pick<RightsizingRunRecord, "fixtureId">): RightsizingRunRecord {
  return {
    correctFloor: "spec-first",
    shape: "spec-first",
    result: GOOD,
    ...over,
  };
}

/** Write a temp thresholds.json carrying a chosen rightsizing X value; returns its path (drives the pass boundary). */
function thresholdsFile(value: number | null): string {
  const dir = mkdtempSync(join(tmpdir(), "rs-thresholds-"));
  const path = join(dir, "thresholds.json");
  writeFileSync(
    path,
    JSON.stringify({
      moat: { W: { statement: "", metric: "discrimination", delta: null, calibrationPending: true } },
      rightsizing: {
        X: {
          statement: "right-sizing-success ≥ X",
          metric: "rightSizingSuccessRate",
          value,
          calibrationPending: value === null,
        },
      },
    }),
    "utf8",
  );
  return path;
}

/** Find the single census row for a fixture id (asserts exactly one). */
function rowFor(artifact: ReturnType<typeof buildScoredArtifact>, fixtureId: string) {
  const rows = (artifact.census ?? []).filter((r) => r.fixtureId === fixtureId);
  assert.equal(rows.length, 1, `expected one census row for ${fixtureId}`);
  return rows[0]!;
}

// --- the bucketing: the core reframe -----------------------------------------------------------------------------

test("lighter-than-floor + GOOD is a WIN (right-sizing-success), not a miss", () => {
  // The exact bug being fixed: a lighter-than-label route that produced a GOOD result.
  const a = buildScoredArtifact([rec({ fixtureId: "fx", correctFloor: "decompose", shape: "one-shot", result: GOOD })]);
  assert.equal(rowFor(a, "fx").outcome, "right-sizing-success");
  assert.equal(a.rates?.counts.rightSizingSuccess, 1);
});

test("at-floor + GOOD is right-sizing-success", () => {
  const a = buildScoredArtifact([rec({ fixtureId: "fx", correctFloor: "spec-first", shape: "spec-first", result: GOOD })]);
  assert.equal(rowFor(a, "fx").outcome, "right-sizing-success");
});

test("lighter-than-floor + BAD is the only real routing miss (under-route-failure)", () => {
  const a = buildScoredArtifact([rec({ fixtureId: "fx", correctFloor: "decompose", shape: "one-shot", result: BAD })]);
  assert.equal(rowFor(a, "fx").outcome, "under-route-failure");
  assert.equal(a.rates?.counts.underRouteFailure, 1);
});

test("heavier-than-floor + good is over-route-tax (wasted process)", () => {
  const a = buildScoredArtifact([rec({ fixtureId: "fx", correctFloor: "one-shot", shape: "decompose", result: GOOD })]);
  assert.equal(rowFor(a, "fx").outcome, "over-route-tax");
  assert.equal(a.rates?.counts.overRouteTax, 1);
});

// --- the trap cases ----------------------------------------------------------------------------------------------

test("must-escalate trap one-shotted AND succeeded is a WIN (not a miss)", () => {
  const a = buildScoredArtifact([
    rec({ fixtureId: "trap", correctFloor: "decompose", shape: "one-shot", result: GOOD, trap: "must-escalate" }),
  ]);
  assert.equal(rowFor(a, "trap").outcome, "right-sizing-success");
  assert.equal(a.rates?.underRoutedTraps, 0);
});

test("must-escalate trap one-shotted AND failed is the cleanest under-route-failure (counted as under-routed trap)", () => {
  const a = buildScoredArtifact([
    rec({ fixtureId: "trap", correctFloor: "decompose", shape: "one-shot", result: BAD, trap: "must-escalate" }),
  ]);
  assert.equal(rowFor(a, "trap").outcome, "under-route-failure");
  assert.equal(a.rates?.underRoutedTraps, 1);
});

// --- indeterminate: the load-bearing requirement (S3) ------------------------------------------------------------

test("degenerate record (no shape) is indeterminate, excluded from the three rates' denominator", () => {
  const a = buildScoredArtifact([
    rec({ fixtureId: "good", shape: "spec-first", result: GOOD, correctFloor: "spec-first" }),
    rec({ fixtureId: "degenerate", shape: undefined, result: GOOD, correctFloor: "spec-first" }),
  ]);
  assert.equal(rowFor(a, "degenerate").outcome, "indeterminate");
  // denominator EXCLUDES the indeterminate task:
  assert.equal(a.rates?.determinate, 1);
  assert.equal(a.rates?.total, 2);
  assert.equal(a.rates?.counts.indeterminate, 1);
  // never folded into under-route-failure:
  assert.equal(a.rates?.counts.underRouteFailure, 0);
  // the one determinate (good) task gives a full success rate over the determinate denominator:
  assert.equal(a.rates?.rightSizingSuccessRate, 1);
  assert.equal(a.rates?.indeterminateRate, 0.5);
});

test("timeout record (no result) is indeterminate, excluded from the denominator, NOT under-route-failure", () => {
  const a = buildScoredArtifact([
    rec({ fixtureId: "good", shape: "one-shot", result: GOOD, correctFloor: "one-shot" }),
    rec({ fixtureId: "timeout", shape: "one-shot", result: undefined, correctFloor: "decompose" }),
  ]);
  assert.equal(rowFor(a, "timeout").outcome, "indeterminate");
  assert.equal(a.rates?.determinate, 1);
  assert.equal(a.rates?.counts.indeterminate, 1);
  // a timeout that routed lighter than its floor must NOT be folded into under-route-failure:
  assert.equal(a.rates?.counts.underRouteFailure, 0);
  assert.equal(rowFor(a, "timeout").resultGood, null);
});

// --- the good-result threshold boundary --------------------------------------------------------------------------

test("the result-good boundary is inclusive at RESULT_GOOD_THRESHOLD", () => {
  const atBar = buildScoredArtifact([
    rec({ fixtureId: "fx", correctFloor: "spec-first", shape: "one-shot", result: score(RESULT_GOOD_THRESHOLD) }),
  ]);
  assert.equal(rowFor(atBar, "fx").outcome, "right-sizing-success"); // >= bar ⇒ good

  const justBelow = buildScoredArtifact([
    rec({ fixtureId: "fx", correctFloor: "spec-first", shape: "one-shot", result: score(RESULT_GOOD_THRESHOLD - 0.001) }),
  ]);
  assert.equal(rowFor(justBelow, "fx").outcome, "under-route-failure"); // below bar ⇒ bad + lighter ⇒ miss
});

// --- rate aggregation over a mixed batch -------------------------------------------------------------------------

test("rates aggregate over the determinate denominator with indeterminate surfaced separately", () => {
  const a = buildScoredArtifact([
    rec({ fixtureId: "win", correctFloor: "decompose", shape: "one-shot", result: GOOD }),
    rec({ fixtureId: "tax", correctFloor: "one-shot", shape: "decompose", result: GOOD }),
    rec({ fixtureId: "miss", correctFloor: "decompose", shape: "one-shot", result: BAD }),
    rec({ fixtureId: "indet", shape: undefined, result: undefined, correctFloor: "spec-first" }),
  ]);
  const r = a.rates!;
  assert.equal(r.total, 4);
  assert.equal(r.determinate, 3); // the three scored
  assert.equal(r.rightSizingSuccessRate, 1 / 3);
  assert.equal(r.overRouteTaxRate, 1 / 3);
  assert.equal(r.underRouteFailureRate, 1 / 3);
  assert.equal(r.indeterminateRate, 1 / 4); // over the FULL total
});

// --- no bare label-match accuracy --------------------------------------------------------------------------------

test("the scored artifact never exposes a bare label-match accuracy field", () => {
  const a = buildScoredArtifact([rec({ fixtureId: "fx" })]);
  assert.equal((a as Record<string, unknown>).accuracy, undefined);
  assert.equal((a.rates as unknown as Record<string, unknown>).accuracy, undefined);
});

// --- the pre-registered X success condition (form + pass/fail boundary) -------------------------------------------

test("RIGHTSIZING_SUCCESS_THRESHOLD ships the falsifiable FORM (object present, not a bare null)", () => {
  // The registered OBJECT is always present (AC-THRESH); only the calibration value is null while pending.
  assert.notEqual(RIGHTSIZING_SUCCESS_THRESHOLD, null);
  assert.equal(RIGHTSIZING_SUCCESS_THRESHOLD.metric, "rightSizingSuccessRate");
  assert.equal(typeof RIGHTSIZING_SUCCESS_THRESHOLD.statement, "string");
  // the tracked thresholds.json was calibrated from the first run (X=0.8); the form ships with a real number:
  assert.equal(RIGHTSIZING_SUCCESS_THRESHOLD.value, 0.8);
  assert.equal(RIGHTSIZING_SUCCESS_THRESHOLD.calibrationPending, false);
});

test("successCondition computes no pass/fail while X is uncalibrated, but carries the form", () => {
  const path = thresholdsFile(null);
  const a = buildScoredArtifact([rec({ fixtureId: "fx", correctFloor: "spec-first", shape: "one-shot", result: GOOD })], {
    thresholdPath: path,
  });
  assert.equal(a.successCondition.calibrationPending, true);
  assert.equal(a.successCondition.pass, undefined); // no number ⇒ no pass/fail
  assert.equal(a.successCondition.observed, 1); // but the honest observed rate is on record
  assert.notEqual(a.successCondition.target, null);
});

test("successCondition PASSES when the rate clears a calibrated X and no trap is under-routed", () => {
  const path = thresholdsFile(0.5);
  const a = buildScoredArtifact(
    [
      rec({ fixtureId: "a", correctFloor: "spec-first", shape: "one-shot", result: GOOD }), // win
      rec({ fixtureId: "b", correctFloor: "spec-first", shape: "one-shot", result: GOOD }), // win
    ],
    { thresholdPath: path },
  );
  assert.equal(a.rates?.rightSizingSuccessRate, 1);
  assert.equal(a.successCondition.pass, true);
  assert.equal(a.successCondition.calibrationPending, false);
});

test("successCondition FAILS when the rate is below a calibrated X", () => {
  const path = thresholdsFile(0.75);
  const a = buildScoredArtifact(
    [
      rec({ fixtureId: "a", correctFloor: "spec-first", shape: "one-shot", result: GOOD }), // win
      rec({ fixtureId: "b", correctFloor: "decompose", shape: "one-shot", result: BAD }), // miss
    ],
    { thresholdPath: path },
  );
  assert.equal(a.rates?.rightSizingSuccessRate, 0.5);
  assert.equal(a.successCondition.pass, false); // 0.5 < 0.75
});

test("successCondition FAILS when a must-escalate trap is under-routed, even if the rate clears X", () => {
  const path = thresholdsFile(0.5);
  const a = buildScoredArtifact(
    [
      rec({ fixtureId: "a", correctFloor: "spec-first", shape: "one-shot", result: GOOD }), // win
      rec({ fixtureId: "b", correctFloor: "spec-first", shape: "one-shot", result: GOOD }), // win
      rec({ fixtureId: "trap", correctFloor: "decompose", shape: "one-shot", result: BAD, trap: "must-escalate" }), // under-routed trap
    ],
    { thresholdPath: path },
  );
  assert.ok((a.rates?.rightSizingSuccessRate ?? 0) >= 0.5); // 2/3 clears X
  assert.equal(a.rates?.underRoutedTraps, 1);
  assert.equal(a.successCondition.pass, false); // the trap requirement vetoes the pass
});

// --- the aborted / scored discriminator --------------------------------------------------------------------------

test("buildAbortedArtifact emits NO numbers (no rates/census) but keeps the falsifiable form", () => {
  const path = thresholdsFile(0.5);
  const a = buildAbortedArtifact("aa-stability gate fired", { thresholdPath: path });
  assert.equal(a.condition, "aborted");
  assert.equal(a.abortVerdict, "aa-stability gate fired");
  assert.equal(a.rates, undefined); // no number when a gate fires
  assert.equal(a.census, undefined);
  assert.notEqual(a.successCondition.target, null); // the form still ships
  assert.equal(a.successCondition.observed, null); // no observed number on abort
  assert.equal(a.successCondition.pass, undefined); // no pass/fail without a number
});

// --- empty / boundary --------------------------------------------------------------------------------------------

test("an empty batch scores all-zero rates without throwing", () => {
  const a = buildScoredArtifact([]);
  assert.equal(a.condition, "scored");
  assert.equal(a.rates?.total, 0);
  assert.equal(a.rates?.determinate, 0);
  assert.equal(a.rates?.rightSizingSuccessRate, 0);
  assert.equal(a.rates?.indeterminateRate, 0);
});

test("loadRightsizingThreshold throws when the rightsizing key is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-thresholds-bad-"));
  const path = join(dir, "thresholds.json");
  writeFileSync(path, JSON.stringify({ moat: { W: {} } }), "utf8");
  assert.throws(() => loadRightsizingThreshold(path), /rightsizing\.X/);
});
