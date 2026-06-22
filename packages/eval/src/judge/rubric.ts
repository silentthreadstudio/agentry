// The shared RUBRIC value type (ADR-002) — a rubric is DATA, not code. Where `quality/rubric.ts` and
// `outcome-judge/rubric.ts` each baked their dimension set, denominator, and prompt text into a module, the
// shared engine consumes a `Rubric` VALUE: a list of anchored 0/1/2 dimensions, the `max` divisor the engine
// normalizes against (`overall = sum / max`), and the prompt text the judge reads. One engine, many rubrics —
// adding a probe's rubric becomes supplying a value, not authoring another judge module.
//
// This module owns ONLY the value SHAPE + its constructor/normalizer; it authors no concrete rubric (the 4-dim
// outcome and 5-dim decision-quality rubrics stay where they are and are supplied by their probes). The 0/1/2
// vocabulary is fixed across every rubric — `max` is therefore always `dimensions.length * 2`, but it is carried
// on the value so the engine reads the divisor off the rubric rather than re-deriving (or hardcoding) it.

/** The fixed scoring vocabulary: every dimension is an integer 0, 1, or 2. */
export const RUBRIC_MAX_PER_DIMENSION = 2;

/** A per-dimension 0/1/2 score map, keyed by the rubric's own dimension names. */
export type RubricDimensions = Record<string, number>;

/**
 * A rubric the engine can judge against — the value the per-module constants generalize into (ADR-002).
 *
 * @property dimensions the anchored dimension names, in canonical order; the judge returns a 0/1/2 for each.
 * @property max        the denominator for the normalized overall (`sum / max`) — the engine reads it off the
 *                      rubric, so a 4-dim (max 8) and a 5-dim (max 10) rubric both normalize through one path.
 * @property promptText the anchored rubric text the judge prompt embeds (what 0 vs 2 looks like per dimension).
 */
export interface Rubric {
  readonly dimensions: readonly string[];
  readonly max: number;
  readonly promptText: string;
}

/**
 * Build a {@link Rubric} value from its dimension names + prompt text, deriving `max` from the fixed 0/1/2
 * vocabulary (`dimensions.length * 2`). Probes call this so they cannot accidentally desync `max` from their
 * dimension count; the engine still reads `max` off the returned value (never re-derives it).
 */
export function makeRubric(dimensions: readonly string[], promptText: string): Rubric {
  return { dimensions, max: dimensions.length * RUBRIC_MAX_PER_DIMENSION, promptText };
}

/** Normalize a per-dimension 0/1/2 score map to the 0..1 overall: `sum / rubric.max`. */
export function overallFromDimensions(rubric: Rubric, dimensions: RubricDimensions): number {
  const sum = rubric.dimensions.reduce((acc, d) => acc + (dimensions[d] ?? 0), 0);
  return sum / rubric.max;
}
