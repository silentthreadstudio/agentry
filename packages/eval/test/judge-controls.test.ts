// Tests for the shared control layer (ADR-002/003). ZERO API spend: every case is a pure predicate over synthetic
// score arrays — no judge, no `claude -p`, no fs. These two controls are the load-bearing trust gate of every
// probe (a flattering judge is worthless), so the forced cases (a noisy A/A spread, a judge that cannot separate
// gold from broken, a collapsed gap) are exercised directly. (The former PORT-FIDELITY block compared the shared
// controls against `outcome-judge/control.ts`; T-10 deleted that superseded module, so the dead comparison is gone.)

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aaStability,
  discrimination,
  DEFAULT_AA_TOLERANCE,
  DEFAULT_GOLD_MIN,
  DEFAULT_BROKEN_MAX,
  DEFAULT_MIN_GAP,
  DEFAULT_CONTROL_REPEATS,
} from "../src/judge/index.ts";

// --- the pinned default thresholds (ADR-003) -----------------------------------------------------------

test("defaults: gold-min/broken-max/min-gap/tolerance/repeats match the ADR-003 thresholds", () => {
  assert.equal(DEFAULT_GOLD_MIN, 0.7);
  assert.equal(DEFAULT_BROKEN_MAX, 0.4);
  assert.equal(DEFAULT_MIN_GAP, 0.3);
  assert.equal(DEFAULT_AA_TOLERANCE, 0.1);
  assert.equal(DEFAULT_CONTROL_REPEATS, 3);
});

// --- A/A stability — the NEGATIVE control (same subject, k judgements, must agree) ----------------------

test("aaStability: k identical overalls have zero spread => ok, no verdict", () => {
  const result = aaStability([0.8, 0.8, 0.8]);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, undefined);
  assert.ok(result.stdev < 1e-9);
});

test("aaStability: overalls within tolerance still agree => ok", () => {
  const result = aaStability([0.8, 0.85, 0.8]); // stdev ≈ 0.0236 < 0.1
  assert.equal(result.ok, true);
  assert.ok(result.stdev <= DEFAULT_AA_TOLERANCE);
});

test("aaStability: a wide scatter beyond tolerance => measures-noise verdict, abort", () => {
  const result = aaStability([0.2, 0.9, 0.5]); // stdev ≈ 0.287 > 0.1
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "outcome-judge-measures-noise");
  assert.ok(result.stdev > DEFAULT_AA_TOLERANCE);
});

test("aaStability: tolerance is a parameter — a tight tol trips a small spread", () => {
  const result = aaStability([0.8, 0.85, 0.8], 0.01);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "outcome-judge-measures-noise");
});

test("aaStability: an empty/singleton set trivially agrees (stdev 0, ok)", () => {
  assert.deepEqual(aaStability([]), { ok: true, stdev: 0 });
  assert.deepEqual(aaStability([0.7]), { ok: true, stdev: 0 });
});

test("aaStability: the subject label parameterizes the verdict string", () => {
  const result = aaStability([0.2, 0.9, 0.5], DEFAULT_AA_TOLERANCE, "honesty");
  assert.equal(result.verdict, "honesty-judge-measures-noise");
});

// --- gold/broken discrimination — the POSITIVE control (GOLD high, BROKEN low, gap >= minGap) -----------

test("discrimination: GOLD high, BROKEN low, gap clears minGap => ok, no verdict", () => {
  const result = discrimination(0.9, 0.3, 0.7, 0.4, 0.3);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, undefined);
});

test("discrimination: uses the ADR-003 defaults when thresholds are omitted", () => {
  assert.equal(discrimination(0.9, 0.3).ok, true);
});

test("discrimination: a collapsed gap (within bounds but too close) => cannot-discriminate", () => {
  const result = discrimination(0.8, 0.7, 0.7, 0.4, 0.3);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "outcome-judge-cannot-discriminate");
});

test("discrimination: the minGap clause alone trips a within-bounds near-tie", () => {
  const result = discrimination(0.7, 0.4, 0.7, 0.4, 0.4); // bounds pass; gap 0.3 < minGap 0.4
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "outcome-judge-cannot-discriminate");
});

test("discrimination: GOLD below its floor => cannot-discriminate", () => {
  const result = discrimination(0.6, 0.2, 0.7, 0.4, 0.3);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "outcome-judge-cannot-discriminate");
});

test("discrimination: BROKEN above its ceiling => cannot-discriminate", () => {
  const result = discrimination(0.9, 0.5, 0.7, 0.4, 0.3);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "outcome-judge-cannot-discriminate");
});

test("discrimination: inverted (GOLD scored below BROKEN) => cannot-discriminate", () => {
  const result = discrimination(0.3, 0.9, 0.7, 0.4, 0.3);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "outcome-judge-cannot-discriminate");
});

test("discrimination: the subject label parameterizes the verdict string", () => {
  const result = discrimination(0.3, 0.9, 0.7, 0.4, 0.3, "honesty");
  assert.equal(result.verdict, "honesty-judge-cannot-discriminate");
});
