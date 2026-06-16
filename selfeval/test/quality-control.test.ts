// Tests for the decision-quality control layer (design §3). ZERO API spend: every case is a pure predicate over
// synthetic score arrays — no judge, no `claude -p`, no fs. These two controls are the load-bearing part of the
// quality eval (a flattering judge is worthless), so the forced cases (a noisy A/A spread, a judge that cannot
// separate planted GOLD from POOR) are exercised directly: when a control fires, it emits the PINNED verdict the
// artifact/probe consume verbatim.

import assert from "node:assert/strict";
import { test } from "node:test";

import { aaJudgeStability, plantedDiscrimination, DEFAULT_AA_TOLERANCE } from "../src/quality/control.ts";

// --- A/A judge-stability — the NEGATIVE control (same artifact, k judgements, must agree) --------------

test("aaJudgeStability: k identical overalls have zero spread => ok, no verdict", () => {
  const result = aaJudgeStability([0.8, 0.8, 0.8]);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, undefined);
  // Identical inputs ⇒ effectively zero spread (allowing for float rounding in the variance computation).
  assert.ok(result.stdev < 1e-9);
});

test("aaJudgeStability: overalls within tolerance still agree => ok", () => {
  // stdev of [0.80, 0.85, 0.80] ≈ 0.0236, well under the 0.1 default tolerance.
  const result = aaJudgeStability([0.8, 0.85, 0.8]);
  assert.equal(result.ok, true);
  assert.ok(result.stdev <= DEFAULT_AA_TOLERANCE);
});

test("aaJudgeStability: a wide scatter beyond tolerance => judge-measures-noise, abort", () => {
  // stdev of [0.2, 0.9, 0.5] ≈ 0.287 — the judge gave the SAME artifact wildly different scores.
  const result = aaJudgeStability([0.2, 0.9, 0.5]);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "judge-measures-noise");
  assert.ok(result.stdev > DEFAULT_AA_TOLERANCE);
});

test("aaJudgeStability: tolerance is a parameter — a tight tol trips a small spread", () => {
  // stdev ≈ 0.0236; ok under default 0.1, but fails a strict 0.01 tolerance.
  const result = aaJudgeStability([0.8, 0.85, 0.8], 0.01);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "judge-measures-noise");
});

// --- planted discrimination — the POSITIVE control (GOLD high, POOR low, GOLD > POOR) -----------------

test("plantedDiscrimination: GOLD high, POOR low, GOLD>POOR => ok, no verdict", () => {
  const result = plantedDiscrimination(0.9, 0.2, 0.7, 0.4);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, undefined);
});

test("plantedDiscrimination: GOLD below its floor => judge-cannot-discriminate", () => {
  // GOLD 0.6 < goldMin 0.7 — the judge failed to recognize the planted good artifact.
  const result = plantedDiscrimination(0.6, 0.2, 0.7, 0.4);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "judge-cannot-discriminate");
});

test("plantedDiscrimination: POOR above its ceiling => judge-cannot-discriminate", () => {
  // POOR 0.5 > poorMax 0.4 — the judge was too generous to the planted bad artifact.
  const result = plantedDiscrimination(0.9, 0.5, 0.7, 0.4);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "judge-cannot-discriminate");
});

test("plantedDiscrimination: GOLD <= POOR (no separation) => judge-cannot-discriminate", () => {
  // Even within individual bounds, GOLD must strictly beat POOR; equal overalls means no discriminating power.
  const result = plantedDiscrimination(0.7, 0.7, 0.7, 0.7);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "judge-cannot-discriminate");
});

test("plantedDiscrimination: inverted (GOLD scored below POOR) => judge-cannot-discriminate", () => {
  // The judge ranked the bad artifact above the good one — the clearest possible discrimination failure.
  const result = plantedDiscrimination(0.3, 0.9, 0.7, 0.4);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "judge-cannot-discriminate");
});
