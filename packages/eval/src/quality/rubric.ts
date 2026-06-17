// The decision-quality RUBRIC (design §1) — the five anchored dimensions the judge scores a conductor-produced
// spec/plan against, plus the rubric TEXT the judge prompt embeds. This module owns ONLY the rubric definition
// (the scoring vocabulary + the prompt the judge reads); judge.ts owns the LLM call, control.ts the gates.
//
// Each dimension is scored 0 / 1 / 2 against an anchored description; `overall = sum / 10` (5 dims × max 2 = 10).
// The rubric judges CONTENT — the surfaced forks, chosen options, override hints, scope — NOT length/formatting:
// a verbose artifact must not out-score a crisp one. The prompt states this explicitly so the judge cannot be
// gamed by padding.

/** The five quality dimensions, in their canonical order. The judge returns a 0/1/2 score for each. */
export const QUALITY_DIMENSIONS = [
  "forkSurfacing",
  "decisionSoundness",
  "accountability",
  "scope",
  "coherence",
] as const;

/** A single quality dimension name (one of the five). */
export type QualityDimension = (typeof QUALITY_DIMENSIONS)[number];

/** The per-dimension 0/1/2 scores the judge assigns (one entry per {@link QUALITY_DIMENSIONS}). */
export type QualityDimensions = Record<QualityDimension, number>;

/** The maximum sum (5 dimensions × 2) — the denominator for the normalized `overall`. */
export const MAX_DIMENSION_SUM = QUALITY_DIMENSIONS.length * 2;

/** Normalize a per-dimension score map to the 0..1 overall: `sum / 10`. */
export function overallFromDimensions(dimensions: QualityDimensions): number {
  const sum = QUALITY_DIMENSIONS.reduce((acc, d) => acc + dimensions[d], 0);
  return sum / MAX_DIMENSION_SUM;
}

/**
 * The anchored rubric the judge prompt embeds. Each dimension states what 0 vs 2 looks like so the judge
 * grades against a fixed bar, not a vibe. The closing CONTENT clause is load-bearing: it forbids rewarding
 * verbosity/formatting, so length cannot be the discriminator (design §1, §4).
 */
export const RUBRIC_TEXT = `Score the artifact on FIVE dimensions, each 0, 1, or 2 (integers only):

1. forkSurfacing — did it identify the genuinely load-bearing decisions the task hides?
   0 = missed the real fork, or surfaced only trivia.
   1 = named some real decisions but missed at least one that carries consequence.
   2 = named the decisions that actually carry consequence for this task.

2. decisionSoundness — are the chosen options defensible / senior?
   0 = arbitrary or wrong choices.
   1 = reasonable but with a notable gap or weak justification.
   2 = the choice a senior engineer would defend.

3. accountability — is each auto-decided fork named with its assumption AND an ACTIONABLE override hint
   (the auto-pilot contract)?
   0 = silent guesses, no assumptions stated, no overrides.
   1 = forks named with assumptions but missing actionable override hints (not reversible).
   2 = every surfaced fork carries an assumption AND a one-line, actionable override hint.

4. scope — right-sized: appropriate non-goals, neither over- nor under-scoped for the task.
   0 = scope wrong or absent.
   1 = scope present but loose, or non-goals missing/misjudged.
   2 = crisp scope with sensible non-goals.

5. coherence — does the artifact actually address the task's goal end-to-end?
   0 = off-target or incomplete.
   1 = addresses the goal but leaves a meaningful gap.
   2 = fully addresses the task's goal.

JUDGE CONTENT, NOT LENGTH OR FORMATTING. A longer or more elaborately formatted artifact must NOT score
higher for that reason alone — reward only the substance (the real forks named, the soundness of the chosen
options, the override hints, the scope discipline). A short, crisp artifact that nails the substance outscores
a long one that does not.`;
