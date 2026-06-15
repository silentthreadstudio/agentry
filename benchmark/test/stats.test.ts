// Tests for the statistics modules (T-008, M6). ZERO API spend — everything runs on synthetic CellResult
// fixtures and numeric series; no `claude -p` is ever invoked. Proves the falsifiability core of the
// instrument: AC4 (variance honesty), AC7 (paired delta), AC13 (honest-null reachable), AC9 (statistical
// reproducibility), and that N / min-effect / tolerance are config-driven, not hard-coded.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { CellResult, RunRecord, Scoreboard } from "../src/types.ts";
import { aggregate, aggregateCell } from "../src/stats/aggregate.ts";
import { pairedDelta, mulberry32, type BootstrapConfig } from "../src/stats/bootstrap.ts";
import { verdict, reproducible, reproducibleClaims, type ReproClaims } from "../src/stats/verdict.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "stats");

interface ArmPairFixture {
  warmC: CellResult;
  coldB: CellResult;
}

function loadArmPair(name: string): ArmPairFixture {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as ArmPairFixture;
  return raw;
}

/** The metric series these fixtures vary along — full-run dollar cost per run. */
const costMetric = (r: RunRecord): number => r.cost.totalCostUsd;

// Config-driven inputs (AC5: N / min-effect / tolerance come from config, never hard-coded in the modules).
const BOOTSTRAP_CONFIG: BootstrapConfig = { resamples: 2000, ciLevel: 0.95, seed: 12345 };
const MIN_EFFECT = { minEffectSize: 0.8 };

// --- aggregate.ts: AC4 variance honesty --------------------------------------

test("aggregate at N=1 returns variance undefined (AC4), never a fake zero", () => {
  const result = aggregate([0.2]);
  assert.equal(result.mean, 0.2);
  assert.equal(result.variance, undefined);
  assert.equal(result.n, 1);
});

test("aggregate at N>=2 returns a real (Bessel-corrected) variance", () => {
  const result = aggregate([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(result.mean, 5);
  // sample variance of this classic series is 32/7 ≈ 4.571 (÷(N−1)=7), NOT the population 4.0.
  assert.ok(result.variance !== undefined);
  assert.ok(Math.abs(result.variance - 32 / 7) < 1e-9, `got ${result.variance}`);
  assert.equal(result.n, 8);
});

test("aggregate on an empty series throws (N=0 has no mean)", () => {
  assert.throws(() => aggregate([]), /empty series/);
});

test("aggregateCell pulls a numeric series out of a CellResult via the metric accessor (grader-decoupled)", () => {
  const { coldB } = loadArmPair("equivalent-arms-null.json");
  const result = aggregateCell(coldB, costMetric);
  assert.equal(result.n, coldB.runs.length);
  assert.ok(result.variance !== undefined, "N>=2 cell must report a real variance");
  assert.ok(result.mean > 0.19 && result.mean < 0.21, `mean off: ${result.mean}`);
});

// --- bootstrap.ts: AC7 paired delta + determinism ----------------------------

test("pairedDelta returns delta + 95% CI + effect size for a synthetic C/B pair (AC7)", () => {
  const { warmC, coldB } = loadArmPair("clear-separation-win.json");
  const warm = warmC.runs.map(costMetric);
  const cold = coldB.runs.map(costMetric);
  const d = pairedDelta(warm, cold, BOOTSTRAP_CONFIG);

  // C costs ~0.12, B ~0.20 → delta (C−B) is a stable ~−0.08.
  assert.ok(d.delta < -0.07 && d.delta > -0.09, `delta off: ${d.delta}`);
  assert.equal(d.ci95.length, 2);
  assert.ok(d.ci95[0] <= d.ci95[1], "CI must be ordered [lo, hi]");
  assert.ok(Number.isFinite(d.effectSize));
  assert.ok(d.ciHalfWidth >= 0);
});

test("pairedDelta is deterministic for a fixed seed (reproducible CI, not Math.random)", () => {
  const warm = [0.12, 0.122, 0.118, 0.121, 0.119];
  const cold = [0.2, 0.202, 0.198, 0.201, 0.2];
  const a = pairedDelta(warm, cold, BOOTSTRAP_CONFIG);
  const b = pairedDelta(warm, cold, BOOTSTRAP_CONFIG);
  assert.deepEqual(a.ci95, b.ci95);
  assert.equal(a.delta, b.delta);
});

test("pairedDelta seed is config-driven: a different seed gives a different CI on noisy data", () => {
  // 20 noisy per-pair differences — enough distinct values that the bootstrap tail quantiles are
  // seed-sensitive (at small N the quantiles can collapse onto the same order statistics, so we use N=20).
  const diffs = [
    -0.08, -0.03, -0.12, -0.05, -0.09, -0.02, -0.15, -0.07, -0.04, -0.11, -0.06, -0.1, -0.01, -0.13,
    -0.08, -0.05, -0.14, -0.03, -0.09, -0.07,
  ];
  const cold = diffs.map(() => 0.2);
  const warm = diffs.map((d) => 0.2 + d);
  const a = pairedDelta(warm, cold, { resamples: 2000, ciLevel: 0.95, seed: 1 });
  const b = pairedDelta(warm, cold, { resamples: 2000, ciLevel: 0.95, seed: 999 });
  // The point delta is seed-independent; the bootstrap CI bounds are resample-driven, so they differ.
  assert.equal(a.delta, b.delta);
  assert.notDeepEqual(a.ci95, b.ci95);
});

test("pairedDelta throws on misaligned arm lengths (a paired stat needs matched observations)", () => {
  assert.throws(() => pairedDelta([1, 2, 3], [1, 2], BOOTSTRAP_CONFIG), /misaligned/);
});

test("mulberry32 is a deterministic PRNG (same seed → same sequence)", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  for (const x of seqA) assert.ok(x >= 0 && x < 1, `PRNG out of [0,1): ${x}`);
});

// --- verdict.ts: AC13 honest-null reachable both ways ------------------------

test("verdict returns 'null' on the equivalent-arms fixture (AC13 — the null path is reachable)", () => {
  const { warmC, coldB } = loadArmPair("equivalent-arms-null.json");
  const d = pairedDelta(warmC.runs.map(costMetric), coldB.runs.map(costMetric), BOOTSTRAP_CONFIG);
  // The arms are equivalent → the C−B CI straddles 0 → honest null.
  assert.ok(d.ci95[0] <= 0 && d.ci95[1] >= 0, `CI should straddle 0, got ${JSON.stringify(d.ci95)}`);
  assert.equal(verdict(d, MIN_EFFECT), "null");
});

test("verdict returns 'win' on the clear-separation fixture (CI excludes 0 AND effect clears min)", () => {
  const { warmC, coldB } = loadArmPair("clear-separation-win.json");
  const d = pairedDelta(warmC.runs.map(costMetric), coldB.runs.map(costMetric), BOOTSTRAP_CONFIG);
  assert.ok(d.ci95[0] < 0 && d.ci95[1] < 0, `CI should be entirely below 0, got ${JSON.stringify(d.ci95)}`);
  assert.ok(Math.abs(d.effectSize) >= MIN_EFFECT.minEffectSize, `effect too small: ${d.effectSize}`);
  assert.equal(verdict(d, MIN_EFFECT), "win");
});

test("verdict min-effect-size is config-driven: a clear separation reads 'null' under a higher bar", () => {
  const { warmC, coldB } = loadArmPair("clear-separation-win.json");
  const d = pairedDelta(warmC.runs.map(costMetric), coldB.runs.map(costMetric), BOOTSTRAP_CONFIG);
  // Same data, same CI (still excludes 0), but a higher min-effect bar than the data's |dz| → honest null.
  assert.ok(Math.abs(d.effectSize) < 50, `effect should be finite and below the raised bar: ${d.effectSize}`);
  assert.equal(verdict(d, { minEffectSize: 50 }), "null");
});

// --- verdict.ts: AC9 statistical reproducibility -----------------------------

function reproClaim(verdictVal: "win" | "null", mean: number, halfWidth: number) {
  return { verdict: verdictVal, mean, ciHalfWidth: halfWidth } as const;
}

function claims(c: ReturnType<typeof reproClaim>): ReproClaims {
  return { c1: c, c2: c, c3: c, c4: c };
}

test("reproducibleClaims is true when verdicts match AND means agree within CI half-width (AC9)", () => {
  const runA = claims(reproClaim("win", 100, 5));
  const runB = claims(reproClaim("win", 103, 5)); // gap 3 < half-width 5 → reproducible
  assert.equal(reproducibleClaims(runA, runB), true);
});

test("reproducibleClaims is false when a verdict flips (identical means cannot rescue it)", () => {
  const runA = claims(reproClaim("win", 100, 5));
  const runB = claims(reproClaim("null", 100, 5));
  assert.equal(reproducibleClaims(runA, runB), false);
});

test("reproducibleClaims is false when means drift beyond the CI half-width (statistical, not bit-equal)", () => {
  const runA = claims(reproClaim("win", 100, 1));
  const runB = claims(reproClaim("win", 110, 1)); // gap 10 > half-width 1 → not reproducible
  assert.equal(reproducibleClaims(runA, runB), false);
});

test("reproducible(Scoreboard, Scoreboard) compares verdicts + variance-band tolerance (AC9)", () => {
  const claim = (v: "win" | "null", delta: number, variance: number) => ({ verdict: v, delta, variance });
  const board = (delta: number, variance: number): Scoreboard => ({
    claims: {
      c1: claim("win", delta, variance),
      c2: claim("null", 0, variance),
      c3: claim("win", delta, variance),
      c4: claim("null", 0, variance),
    },
    perRegime: [],
    r3: [],
  });
  // variance 4 → tolerance sqrt(4)=2; deltas −0.08 vs −0.085 agree within 2 → reproducible.
  assert.equal(reproducible(board(-0.08, 4), board(-0.085, 4)), true);
  // Same boards but a flipped verdict on c1 → not reproducible.
  const flipped = board(-0.08, 4);
  flipped.claims.c1 = { verdict: "null", delta: -0.08, variance: 4 };
  assert.equal(reproducible(board(-0.08, 4), flipped), false);
});

test("reproducible is false when a delta drifts beyond the variance band (statistical tolerance)", () => {
  const claim = (v: "win" | "null", delta: number, variance: number) => ({ verdict: v, delta, variance });
  const board = (delta: number): Scoreboard => ({
    claims: {
      c1: claim("win", delta, 0.0001),
      c2: claim("win", delta, 0.0001),
      c3: claim("win", delta, 0.0001),
      c4: claim("win", delta, 0.0001),
    },
    perRegime: [],
    r3: [],
  });
  // tolerance sqrt(0.0001)=0.01; deltas 1.0 vs 2.0 differ by 1.0 >> 0.01 → not reproducible.
  assert.equal(reproducible(board(1.0), board(2.0)), false);
});
