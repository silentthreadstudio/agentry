// SHARED JUDGE INFRA (relocated by T-10 from `outcome-judge/rubric.ts`). `OUTCOME_DIMENSIONS` + `RUBRIC_TEXT` are
// the rubric DATA the live rightsizing probe feeds the shared judge engine (`makeRubric`), so they survived the
// deletion of `outcome-judge/` and now live in the NEUTRAL `src/conduct/` home — no probe imports another probe's
// old folder.
//
// The outcome-criteria RUBRIC (ADR-002 / Spec v2 BUILD §1) — the FOUR anchored dimensions the judge scores a
// task's PRODUCED RESULT (the code an open-ended task yields) against, plus the rubric TEXT the judge prompt
// embeds. This module owns ONLY the rubric definition (the scoring vocabulary + the prompt the judge reads);
// judge.ts (T-04) owns the LLM call, control.ts (T-04) the gates. It mirrors `quality/rubric.ts` EXACTLY in
// shape — the only differences are the 4-dimension set, the `/8` denominator, and an anti-gaming clause adapted
// to scoring CODE quality rather than a decision artifact's text.
//
// Each dimension is scored 0 / 1 / 2 against an anchored description; `overall = sum / 8` (4 dims × max 2 = 8).
// The rubric judges the SUBSTANCE of the produced code — does it meet the intent, is it correct, is it sound,
// is it complete — NOT the volume of code or its formatting: a sprawling solution must not out-score a tight
// one. The prompt states this explicitly so the judge cannot be gamed by padding the output.

/** The four outcome dimensions, in their canonical order. The judge returns a 0/1/2 score for each. */
export const OUTCOME_DIMENSIONS = ["meetsIntent", "correct", "soundCode", "complete"] as const;

/** A single outcome dimension name (one of the four). */
export type OutcomeDimension = (typeof OUTCOME_DIMENSIONS)[number];

/** The per-dimension 0/1/2 scores the judge assigns (one entry per {@link OUTCOME_DIMENSIONS}). */
export type OutcomeDimensions = Record<OutcomeDimension, number>;

/** The maximum sum (4 dimensions × 2) — the denominator for the normalized `overall`. */
export const MAX_DIMENSION_SUM = OUTCOME_DIMENSIONS.length * 2;

/** Normalize a per-dimension score map to the 0..1 overall: `sum / 8`. */
export function overallFromDimensions(dimensions: OutcomeDimensions): number {
  const sum = OUTCOME_DIMENSIONS.reduce((acc, d) => acc + dimensions[d], 0);
  return sum / MAX_DIMENSION_SUM;
}

/**
 * The anchored rubric the judge prompt embeds. Each dimension states what 0 vs 2 looks like so the judge grades
 * the produced code against a fixed bar, not a vibe. The closing CONTENT clause is load-bearing: it forbids
 * rewarding more code / heavier formatting, so volume cannot be the discriminator (ADR-002 / Spec v2 BUILD §1).
 */
export const RUBRIC_TEXT = `Score the PRODUCED RESULT (the code the task yielded) on FOUR dimensions, each 0, 1, or 2 (integers only):

1. meetsIntent — does the produced code do what the task actually asked for?
   0 = solves the wrong problem, or ignores the task's intent.
   1 = addresses the intent but misreads or drops a meaningful part of it.
   2 = does exactly what the task asked, reading the intent correctly.

2. correct — is the code actually right on the cases that matter (including the edges)?
   0 = wrong on the core case, or broken / does not run.
   1 = right on the happy path but wrong or unhandled on a real edge (empty/boundary/error input).
   2 = correct on the core case AND the edges a competent engineer would cover.

3. soundCode — is it good, idiomatic, well-structured code (not just code that happens to pass)?
   0 = unsound: tangled, unsafe, or fighting the language/conventions.
   1 = works but with a notable smell — poor naming, needless complexity, or a fragile shortcut.
   2 = clean, idiomatic, well-structured code a senior engineer would accept in review.

4. complete — is the deliverable finished, or are there stubs / TODOs / missing pieces?
   0 = substantially incomplete: stubs, TODOs, or whole required pieces absent.
   1 = mostly there but with a gap — a missing case, an unwired piece, or an unfinished edge.
   2 = a finished deliverable with nothing required left undone.

JUDGE CONTENT, NOT VOLUME OR FORMATTING. MORE code, extra files, or heavier comments/formatting must NOT score
higher for that reason alone — reward only the substance (the intent met, the correctness on real cases, the
soundness of the structure, the completeness of the deliverable). A small, tight solution that nails the
substance outscores a large, sprawling one that does not.`;
