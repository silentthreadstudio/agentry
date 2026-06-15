// Paired (C−B) bootstrap 95% CI + effect size over a metric series (Plan §2.1 M6, AC7).
//
// PAIRED because arms B (cold) and C (warm) run the SAME follow-up task in lockstep — observation i of C
// pairs with observation i of B, so we resample the per-pair DIFFERENCES, not the two arms independently.
//
// DECOUPLED from the grader: the inputs are two numeric series (warm[i], cold[i]) — the orchestrator T-010
// supplies the metric values (token totals, turns, or AC-pass-rate as a plain number). No GradeResult here.
//
// DETERMINISM: resampling uses a seeded PRNG we control (mulberry32), NOT `Math.random` — `Math.random` is
// unseedable (and may be unavailable in some harnesses), so tests over it would be flaky. With a fixed seed
// the CI is bit-reproducible; the seed and the bootstrap parameters (resamples, ci level, min effect size)
// all come from config (BootstrapConfig), never hard-coded constants (AC: §6.1 OQ3 values are calibratable).

/** Bootstrap parameters — config-driven inputs, NOT hard-coded constants (Spec §6.1 OQ3 is calibratable). */
export interface BootstrapConfig {
  /** Number of bootstrap resamples (e.g. 2000). More → tighter CI estimate, slower. */
  resamples: number;
  /** Confidence level in (0,1), e.g. 0.95 for a 95% CI. */
  ciLevel: number;
  /** Deterministic PRNG seed so the CI is reproducible across runs (AC9 builds on this). */
  seed: number;
}

/** A paired-delta result: the point delta, its bootstrap CI, the effect size, and the resolved CI level. */
export interface PairedDelta {
  /** Mean of the paired differences (warm[i] − cold[i]) — the point estimate of the C−B delta. */
  delta: number;
  /** Bootstrap CI of the mean paired difference at `ciLevel`, as [lo, hi]. */
  ci95: [number, number];
  /** Standardized effect size: mean paired difference / std-dev of the paired differences (Cohen's dz). */
  effectSize: number;
  /** Half-width of the CI ((hi − lo) / 2) — the tolerance AC9's reproducibility check compares means against. */
  ciHalfWidth: number;
  /** The confidence level actually used (echoed from config for downstream rendering). */
  ciLevel: number;
}

/**
 * mulberry32 — a tiny, fast, well-distributed seeded PRNG. Deterministic for a given seed, so the bootstrap
 * is reproducible without depending on `Math.random`. Returns a generator of floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Population standard deviation of a series (÷N) — the effect-size denominator. Returns 0 for N<1. */
function stdDev(series: readonly number[], mean: number): number {
  if (series.length === 0) return 0;
  const variance = series.reduce((sum, x) => sum + (x - mean) * (x - mean), 0) / series.length;
  return Math.sqrt(variance);
}

/** The `p`-quantile of an already-sorted ascending series, via linear interpolation between order stats. */
function quantileSorted(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0]!;
  const pos = (n - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

/**
 * Paired bootstrap of the mean (warm − cold) difference. `warm` and `cold` must be the same length (one entry
 * per paired observation); throws otherwise so a misaligned pair is a loud bug, not a silent statistic.
 *
 * Resamples the per-pair differences `d[i] = warm[i] − cold[i]` with replacement `resamples` times, takes the
 * mean of each resample, and returns the central `ciLevel` interval of those means as the CI. Effect size is
 * the standardized mean difference (Cohen's dz = mean(d) / sd(d)). All parameters come from `config`.
 */
export function pairedDelta(
  warm: readonly number[],
  cold: readonly number[],
  config: BootstrapConfig,
): PairedDelta {
  if (warm.length !== cold.length) {
    throw new Error(`pairedDelta: arms misaligned — warm has ${warm.length}, cold has ${cold.length}`);
  }
  const n = warm.length;
  if (n === 0) {
    throw new Error("pairedDelta: empty arms — need at least one paired observation");
  }

  const diffs = warm.map((w, i) => w - cold[i]!);
  const delta = diffs.reduce((sum, d) => sum + d, 0) / n;
  const sd = stdDev(diffs, delta);
  // dz: when there is no spread, a non-zero delta is an infinitely strong effect; a zero delta is no effect.
  const effectSize = sd === 0 ? (delta === 0 ? 0 : delta > 0 ? Infinity : -Infinity) : delta / sd;

  const rng = mulberry32(config.seed);
  const means = new Array<number>(config.resamples);
  for (let b = 0; b < config.resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      sum += diffs[idx]!;
    }
    means[b] = sum / n;
  }
  means.sort((x, y) => x - y);

  const alpha = 1 - config.ciLevel;
  const lo = quantileSorted(means, alpha / 2);
  const hi = quantileSorted(means, 1 - alpha / 2);
  const ciHalfWidth = (hi - lo) / 2;

  return { delta, ci95: [lo, hi], effectSize, ciHalfWidth, ciLevel: config.ciLevel };
}
