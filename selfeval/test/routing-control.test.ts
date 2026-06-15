// Tests for the control layer (AC6–AC8 / OQ4). ZERO API spend: every case is a pure predicate over synthetic
// `Shape` arrays — no runner, no `claude -p`, no fs. These three controls are the load-bearing part of the
// Spec, so the forced cases (a noise split, a positive-control miss, a saturation collapse) are exercised
// directly: when a control fires, it must emit the PINNED verdict string the artifact/probe consume verbatim.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Shape } from "../src/routing/shape.ts";
import { aaUnanimity, positiveControl, saturationGuard } from "../src/routing/control.ts";

// --- AC6 / OQ4: the A/A negative control (k=3 unanimous) ----------------------------------------------

test("aaUnanimity: 3 identical shapes are the null => ok, no verdict", () => {
  const result = aaUnanimity(["spec-first", "spec-first", "spec-first"]);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, undefined);
});

test("aaUnanimity: a split across the 3 repeats => fail with the instrument-measures-noise verdict, no score", () => {
  const result = aaUnanimity(["spec-first", "spec-first", "decompose"]);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "instrument-measures-noise");
});

test("aaUnanimity: a one-off difference anywhere in the set still trips the noise verdict", () => {
  // first element differs — guard against an implementation that only compares neighbours / last-vs-first.
  const result = aaUnanimity(["decompose", "spec-first", "spec-first"]);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "instrument-measures-noise");
});

test("aaUnanimity: k is a parameter — unanimity at a non-default k passes", () => {
  const result = aaUnanimity(["one-shot", "one-shot"], 2);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, undefined);
});

test("aaUnanimity: k is a parameter — a split at a non-default k still trips noise", () => {
  const result = aaUnanimity(["one-shot", "decompose", "one-shot", "one-shot"], 4);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "instrument-measures-noise");
});

test("aaUnanimity: a repeat count that doesn't match k cannot establish the null => fail", () => {
  // Only 2 captures supplied for a k=3 A/A run: the null is unestablished, so it must not be reported ok.
  const result = aaUnanimity(["spec-first", "spec-first"], 3);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "instrument-measures-noise");
});

// --- AC7: the planted positive control ----------------------------------------------------------------

test("positiveControl: observed matches the planted shape => ok, no verdict", () => {
  const result = positiveControl("spec-first", "spec-first");
  assert.equal(result.ok, true);
  assert.equal(result.verdict, undefined);
});

test("positiveControl: observed differs from planted => positive-control-missed verdict (plumbing broken)", () => {
  // A broken extractor that returns the wrong shape for a hard-coded case must be caught loudly.
  const result = positiveControl("decompose", "one-shot");
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "positive-control-missed");
});

// --- AC8: the saturation / no-discriminating-power guard (DISPATCHED spread, not labeled) --------------

test("saturationGuard: all observed collapse to one shape => no-discriminating-power, power false", () => {
  const observed: Shape[] = ["spec-first", "spec-first", "spec-first", "spec-first"];
  const result = saturationGuard(observed);
  assert.equal(result.power, false);
  assert.equal(result.verdict, "no-discriminating-power");
});

test("saturationGuard: a spread across ≥2 distinct shapes => power true, no verdict", () => {
  const observed: Shape[] = ["one-shot", "spec-first", "decompose", "spec-first"];
  const result = saturationGuard(observed);
  assert.equal(result.power, true);
  assert.equal(result.verdict, undefined);
});

test("saturationGuard: exactly two distinct shapes is enough discriminating power", () => {
  const observed: Shape[] = ["one-shot", "decompose"];
  const result = saturationGuard(observed);
  assert.equal(result.power, true);
  assert.equal(result.verdict, undefined);
});

test("saturationGuard: an empty observed set has no spread => no-discriminating-power", () => {
  const result = saturationGuard([]);
  assert.equal(result.power, false);
  assert.equal(result.verdict, "no-discriminating-power");
});
