// Tests for the outcome-criteria RUBRIC (ADR-002 / AC2) — the PURE scoring vocabulary the outcome judge embeds.
// ZERO API: this module is pure (no `claude -p`), so the tests assert the canonical dimension set, the `sum/8`
// normalization at the anchor points the acceptance pins, and that the rubric text carries the anti-gaming
// CONTENT-not-volume clause adapted to scoring code.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OUTCOME_DIMENSIONS,
  MAX_DIMENSION_SUM,
  RUBRIC_TEXT,
  overallFromDimensions,
  type OutcomeDimensions,
} from "../src/conduct/outcome-rubric.ts";

// --- the canonical dimension set ------------------------------------------------------------------------------

test("OUTCOME_DIMENSIONS is exactly the four named dims, in order", () => {
  assert.deepEqual([...OUTCOME_DIMENSIONS], ["meetsIntent", "correct", "soundCode", "complete"]);
});

test("MAX_DIMENSION_SUM is 8 (4 dims × max 2) — the /8 denominator", () => {
  assert.equal(MAX_DIMENSION_SUM, 8);
});

// --- overallFromDimensions: the sum/8 normalizer at the pinned anchor points ----------------------------------

test("overallFromDimensions: all-2 normalizes to overall 1", () => {
  const dims: OutcomeDimensions = { meetsIntent: 2, correct: 2, soundCode: 2, complete: 2 };
  assert.equal(overallFromDimensions(dims), 1);
});

test("overallFromDimensions: all-0 normalizes to overall 0", () => {
  const dims: OutcomeDimensions = { meetsIntent: 0, correct: 0, soundCode: 0, complete: 0 };
  assert.equal(overallFromDimensions(dims), 0);
});

test("overallFromDimensions: {2,2,0,0} normalizes to overall 0.5", () => {
  const dims: OutcomeDimensions = { meetsIntent: 2, correct: 2, soundCode: 0, complete: 0 };
  assert.equal(overallFromDimensions(dims), 0.5);
});

test("overallFromDimensions: a mixed map normalizes to sum/8", () => {
  // sum = 2 + 1 + 2 + 1 = 6 → 6/8 = 0.75.
  const dims: OutcomeDimensions = { meetsIntent: 2, correct: 1, soundCode: 2, complete: 1 };
  assert.equal(overallFromDimensions(dims), 0.75);
});

// --- RUBRIC_TEXT: names every dimension and carries the anti-gaming content clause -----------------------------

test("RUBRIC_TEXT names all four dimensions", () => {
  for (const dim of OUTCOME_DIMENSIONS) {
    assert.ok(RUBRIC_TEXT.includes(dim), `rubric text should mention "${dim}"`);
  }
});

test("RUBRIC_TEXT carries the CONTENT-not-volume anti-gaming clause", () => {
  assert.match(RUBRIC_TEXT, /JUDGE CONTENT, NOT VOLUME OR FORMATTING/);
});
