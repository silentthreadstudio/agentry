// Win / honest-null decision + statistical reproducibility (Plan §2.1 M6; AC13, AC9).
//
// AC13 — the instrument's reason to exist (Spec §2): a benchmark that can only show wins is worthless. A
// `'win'` requires BOTH the 95% CI to exclude 0 AND the effect to clear a minimum effect size; anything else
// is an honest `'null'`. The min effect size is config-driven (VerdictConfig.minEffectSize), never hard-coded.
//
// AC9 — reproducibility is STATISTICAL, not bit-deterministic: two runs are reproducible iff (a) their C1–C4
// claim verdicts are identical AND (b) each pair of per-cell means sits within the other run's CI half-width.
// This is the CI-half-width tolerance, NOT a raw-mean equality check.

import type { Scoreboard, Verdict } from "../types.ts";
import type { PairedDelta } from "./bootstrap.ts";

/** Verdict thresholds — config-driven, NOT hard-coded constants (Spec §6.1 OQ3 is calibratable). */
export interface VerdictConfig {
  /** Minimum |effect size| a delta must clear (in addition to the CI excluding 0) to count as a win. */
  minEffectSize: number;
}

/** Whether a CI interval [lo, hi] excludes 0 (entirely above or entirely below zero). */
function ciExcludesZero(ci: readonly [number, number]): boolean {
  const [lo, hi] = ci;
  return lo > 0 || hi < 0;
}

/**
 * Decide a delta's verdict. Returns `'win'` iff the bootstrap CI excludes 0 AND |effectSize| ≥ the configured
 * minimum; otherwise the honest `'null'` (AC13). Never returns `'loss'` here — directionality is the caller's
 * concern (the claim sets which sign is "good"); this gate only answers "is there a measurable effect?".
 */
export function verdict(delta: PairedDelta, config: VerdictConfig): Verdict {
  const significant = ciExcludesZero(delta.ci95);
  const largeEnough = Math.abs(delta.effectSize) >= config.minEffectSize;
  return significant && largeEnough ? "win" : "null";
}

/** Two means are reproducibly-close iff each sits within the other run's CI half-width tolerance (AC9). */
function meansWithinTolerance(
  meanA: number,
  halfWidthA: number,
  meanB: number,
  halfWidthB: number,
): boolean {
  const gap = Math.abs(meanA - meanB);
  // Symmetric tolerance: the means must agree within EACH run's own half-width (the tighter run governs).
  return gap <= halfWidthA && gap <= halfWidthB;
}

/** One run's per-claim summary: the verdict plus the per-cell mean and CI half-width AC9 compares (AC9). */
export interface ReproClaim {
  verdict: Verdict;
  mean: number;
  ciHalfWidth: number;
}

/** The four C1–C4 claims of one benchmark run, in the shape AC9's reproducibility check consumes. */
export interface ReproClaims {
  c1: ReproClaim;
  c2: ReproClaim;
  c3: ReproClaim;
  c4: ReproClaim;
}

const CLAIM_KEYS = ["c1", "c2", "c3", "c4"] as const;

/**
 * AC9 reproducibility over two runs' C1–C4 summaries: `true` iff every claim's verdict is IDENTICAL across
 * the two runs AND every claim's per-run means agree within each other's CI half-width. This is the statistical
 * reproducibility bar — NOT a bit-equality check on raw means (a deterministic-but-noisy instrument still
 * reproduces if it lands the same verdicts within its own measured spread).
 */
export function reproducibleClaims(runA: ReproClaims, runB: ReproClaims): boolean {
  for (const key of CLAIM_KEYS) {
    const a = runA[key];
    const b = runB[key];
    if (a.verdict !== b.verdict) return false;
    if (!meansWithinTolerance(a.mean, a.ciHalfWidth, b.mean, b.ciHalfWidth)) return false;
  }
  return true;
}

/**
 * AC9 over two assembled Scoreboards (the consumed surface, per the pinned `exposes`): compares the C1–C4
 * verdicts directly, and — since a Scoreboard records each claim's `delta`+`variance` but not a CI half-width —
 * derives a per-claim tolerance from the recorded variance (the spread the instrument measured). Two boards
 * reproduce iff verdicts match AND each claim's recorded deltas agree within that variance-derived tolerance.
 *
 * Tolerance = sqrt(variance) (one standard deviation of the measured spread) — a statistical band, not a
 * bit-equality check (AC9). A claim with zero recorded variance demands exact agreement, which is correct: a
 * board that claims zero spread must reproduce its delta exactly.
 */
export function reproducible(runA: Scoreboard, runB: Scoreboard): boolean {
  for (const key of CLAIM_KEYS) {
    const a = runA.claims[key];
    const b = runB.claims[key];
    if (a.verdict !== b.verdict) return false;
    const tolA = Math.sqrt(a.variance);
    const tolB = Math.sqrt(b.variance);
    if (!meansWithinTolerance(a.delta, tolA, b.delta, tolB)) return false;
  }
  return true;
}
