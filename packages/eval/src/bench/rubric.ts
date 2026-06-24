// The TWO rubrics the value bench judges through — both built from EXISTING rubric DATA (the reshape plan §"one
// conduct, four scores"), re-exported as named `Rubric` values so the probe scores Axis A and Axis B through the
// one shared judge engine (`judgeWithRubric`). A rubric is DATA (ADR-002): this module authors NO new rubric prose
// — it composes the two anchored, anti-gaming-clause'd rubric texts that already ship, so the bench inherits their
// validated calibration rather than re-litigating it.
//
//   - DECISION_RUBRIC (Axis A — decision quality): the 5-dim decision rubric (`quality/rubric.ts`), max 10. The
//     judge scores the conduct's DECISION TRAIL (the spec/plan/adr the conductor wrote) — did the thinking surface
//     the real forks, choose soundly, stay scoped.
//   - CODE_RUBRIC    (Axis B — result/code quality): the 4-dim outcome rubric (`conduct/outcome-rubric.ts`), max 8.
//     The judge scores the PRODUCED CODE TREE — does it meet intent, is it correct, sound, complete.
//
// Both rubric texts carry the load-bearing "judge content, not volume/length" clause verbatim, so neither axis can
// be gamed by padding. `makeRubric` derives each `max` from the fixed 0/1/2 vocabulary (5×2=10, 4×2=8), so the
// engine normalizes `overall = sum / max` identically for both.

import { makeRubric, type Rubric } from "../judge/index.ts";

import { OUTCOME_DIMENSIONS, RUBRIC_TEXT as CODE_RUBRIC_TEXT } from "../conduct/outcome-rubric.ts";
import { QUALITY_DIMENSIONS, RUBRIC_TEXT as DECISION_RUBRIC_TEXT } from "../quality/rubric.ts";

/**
 * Axis A — DECISION QUALITY. The 5-dim decision rubric (`forkSurfacing · decisionSoundness · accountability ·
 * scope · coherence`), max 10, judging the conductor's decision trail. Reuses `quality/rubric.ts`'s anchored text
 * verbatim — no new prose authored here (the reshape plan §"rubric.ts: re-export the two existing rubrics").
 */
export const DECISION_RUBRIC: Rubric = makeRubric(QUALITY_DIMENSIONS, DECISION_RUBRIC_TEXT);

/**
 * Axis B — RESULT / CODE QUALITY. The 4-dim outcome rubric (`meetsIntent · correct · soundCode · complete`), max 8,
 * judging the produced code tree. Reuses `conduct/outcome-rubric.ts`'s anchored text verbatim — the same rubric the
 * (retired) rightsizing probe scored produced trees against.
 */
export const CODE_RUBRIC: Rubric = makeRubric(OUTCOME_DIMENSIONS, CODE_RUBRIC_TEXT);
