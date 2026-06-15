// Per-cell central tendency + spread over the N runs of one (regime × arm) cell (Plan §2.1 M6).
//
// DECOUPLED from the grader (T-006) by construction: this module operates on numeric SERIES (the per-run
// metric values the orchestrator T-010 extracts — token totals from RunRecord.cost, AC-pass-rate as a plain
// number), never on GradeResult. `aggregateCell` is a convenience that pulls a numeric series out of a
// CellResult via a caller-supplied metric accessor; it still touches only the PINNED RunRecord/CellResult
// shapes from T-004's types.ts.
//
// AC4 (hard requirement): at N=1 variance is `undefined` — surfaced as such, NEVER silently averaged into a
// fake zero-variance mean. The return type makes `variance` a REQUIRED field whose value may be undefined, so
// a consumer cannot read it as a number without acknowledging the undefined case.

import type { CellResult, RunRecord } from "../types.ts";

/**
 * Mean + spread of a numeric series. `variance` is `undefined` iff the series has fewer than two observations
 * (N<2) — there is no spread to report from a single point (AC4). `n` is the sample size that produced them.
 */
export interface Aggregate {
  mean: number;
  /** Sample variance over N (Bessel-corrected, ÷(N−1)); `undefined` at N<2 — never a fake zero (AC4). */
  variance: number | undefined;
  n: number;
}

/**
 * Aggregate a numeric series into mean + variance. Variance is the sample (Bessel-corrected) variance, which
 * is genuinely undefined for N<2 — reported as `undefined`, not coerced to 0 (AC4). Throws on an empty series
 * (N=0 has no mean either, and a zero-length cell is a caller bug, not a statistic).
 */
export function aggregate(series: readonly number[]): Aggregate {
  const n = series.length;
  if (n === 0) {
    throw new Error("aggregate: empty series has no mean; expected at least one observation");
  }
  const mean = series.reduce((sum, x) => sum + x, 0) / n;
  if (n < 2) {
    // AC4: a single observation has no variance — surface it as undefined, do not invent a zero.
    return { mean, variance: undefined, n };
  }
  const sumSq = series.reduce((sum, x) => sum + (x - mean) * (x - mean), 0);
  const variance = sumSq / (n - 1);
  return { mean, variance, n };
}

/**
 * Aggregate one (regime × arm) cell on a chosen metric. The metric accessor maps each RunRecord to its
 * numeric value (e.g. `r => r.cost.totalCostUsd`, `r => r.cost.numTurns`) — keeping stats decoupled from the
 * grader: the caller decides what number a run contributes; stats only does the arithmetic.
 */
export function aggregateCell(cell: CellResult, metric: (run: RunRecord) => number): Aggregate {
  return aggregate(cell.runs.map(metric));
}
