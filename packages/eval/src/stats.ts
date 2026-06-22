// Tiny pure population-statistics helpers — the single home for the arithmetic mean and population standard
// deviation that the control/score/artifact modules all need. PURE (no I/O), eval-package-internal: these are
// not a cross-package contract type, so they live here, not in @agentry/core. The semantics are POPULATION
// (variance divides by n, not n−1) — matching every prior local copy so no published number changes.

/** Arithmetic mean of `xs` (0 for an empty set). */
export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Population standard deviation of `xs` (0 for an empty/singleton set, and 0 when every value is identical).
 *
 * @param m an OPTIONAL precomputed mean. When the caller already has the mean (the `std(xs, m)` call shape),
 *          pass it to avoid recomputing; otherwise it is derived from `xs`. Either way the result is identical.
 */
export function stdev(xs: readonly number[], m?: number): number {
  if (xs.length === 0) return 0;
  const avg = m ?? mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - avg) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}
