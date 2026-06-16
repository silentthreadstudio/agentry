// The decision-quality PROBE driver (design §5) — the integration finisher that SEQUENCES the pure pieces into
// the gated control flow the design demands, mirroring routing/probe.ts. It calls the (injected) judge at the
// edge and the pure core (the two controls, the artifact builder) at the centre.
//
// THE CONTROL-FLOW ORDER IS THE CONTRACT (design §3, §5) — enforced here, in this exact sequence:
//   (a) A/A judge-stability — judge ONE designated artifact k times; a scatter beyond tolerance ⇒
//       judge-measures-noise, ABORT (no scores).
//   (b) planted discrimination — judge the planted GOLD and POOR fixtures; if the judge can't separate them
//       (GOLD≥goldMin AND POOR≤poorMax AND GOLD>POOR all required) ⇒ judge-cannot-discriminate, ABORT.
//   (c) ONLY THEN — judge each input artifact → emit the scored artifact.
// Each ABORT short-circuits BEFORE the input artifacts are judged — the scoring is unreachable once a gate fires
// (the design §3 "no number when a gate fires" guarantee made observable).
//
// The judge is INJECTED (canned scores in tests = zero spend; the real `claude -p` judge from the command), the
// same seam routing uses for its Runner.

import { judgeArtifact, type JudgeFn, type QualityScore } from "./judge.ts";
import { aaJudgeStability, plantedDiscrimination, DEFAULT_AA_TOLERANCE } from "./control.ts";
import {
  buildScoredArtifact,
  buildAbortedArtifact,
  writeArtifact,
  type QualityArtifact,
  type ScoredArtifact,
} from "./artifact.ts";

/** The A/A repeat count default (design §3: judge the same artifact k times to establish the null). */
export const DEFAULT_JUDGE_REPEATS = 3;
/** The planted-discrimination thresholds (design §3): GOLD must clear `goldMin`, POOR must stay under `poorMax`. */
export const DEFAULT_GOLD_MIN = 0.7;
export const DEFAULT_POOR_MAX = 0.4;

/** One input artifact to score: the task it answers and its rendered spec/plan text. */
export interface QualityInput {
  taskId: string;
  taskPrompt: string;
  artifactText: string;
}

/** The planted fixtures the positive control judges — the shared task and its GOLD / POOR specs (design §4). */
export interface PlantedFixtures {
  taskPrompt: string;
  goldText: string;
  poorText: string;
}

/** Options for one quality-probe run. The `judge` fn is INJECTED (canned in tests; real `claude -p` from the command). */
export interface QualityProbeOptions {
  /** The input artifacts to score (later sourced from a routing run's captured spec.md/plan.md). */
  artifacts: readonly QualityInput[];
  /** The planted GOLD/POOR fixtures + their shared task — the positive control's ground truth. */
  planted: PlantedFixtures;
  /** The judging seam: prompt+model → raw model JSON. Injected in tests for zero API. */
  judge: JudgeFn;
  /** The A/A repeat count (default {@link DEFAULT_JUDGE_REPEATS}). */
  k?: number;
  /** The A/A stability tolerance (max stdev; default {@link DEFAULT_AA_TOLERANCE}). */
  tol?: number;
  /** GOLD's floor for the positive control (default {@link DEFAULT_GOLD_MIN}). */
  goldMin?: number;
  /** POOR's ceiling for the positive control (default {@link DEFAULT_POOR_MAX}). */
  poorMax?: number;
  /** Model id to pin per judge call (the command discovers it from env/config). */
  model?: string;
  /** Where the artifact JSON is written. */
  outPath: string;
}

/** The result of a probe run: the emitted artifact + where it was written. */
export interface QualityResult {
  artifact: QualityArtifact;
  outPath: string;
}

/** Judge one artifact through the injected seam, pinning the model when supplied. */
function judgeOne(
  taskPrompt: string,
  artifactText: string,
  judge: JudgeFn,
  model: string | undefined,
): Promise<QualityScore> {
  return judgeArtifact(taskPrompt, artifactText, { judge, ...(model !== undefined ? { model } : {}) });
}

/**
 * Drive the quality probe end-to-end in the GATED order (design §5), writing the artifact to `opts.outPath`.
 *
 * Flow:
 *   1. (a) A/A judge-stability — judge the designated A/A artifact (the planted GOLD spec, a stable known input)
 *          EXACTLY k times; the overall scores must agree within `tol`. A scatter ⇒ ABORT `judge-measures-noise`.
 *   2. (b) planted discrimination — judge the planted GOLD and POOR fixtures once each; GOLD must score high,
 *          POOR low, GOLD > POOR. A failure to separate ⇒ ABORT `judge-cannot-discriminate`.
 *   3. (c) ONLY THEN — judge each input artifact and emit the scored artifact with the control readouts.
 *
 * Any abort short-circuits BEFORE step 3 — the input artifacts are never judged once a gate fires.
 */
export async function runQualityProbe(opts: QualityProbeOptions): Promise<QualityResult> {
  const k = opts.k ?? DEFAULT_JUDGE_REPEATS;
  const tol = opts.tol ?? DEFAULT_AA_TOLERANCE;
  const goldMin = opts.goldMin ?? DEFAULT_GOLD_MIN;
  const poorMax = opts.poorMax ?? DEFAULT_POOR_MAX;
  const { judge, model, planted } = opts;

  // (a) A/A judge-stability — the designated A/A artifact is the planted GOLD spec (a fixed, known-good input):
  // judging the SAME text k times should land the same overall. A scatter beyond tolerance means the judge is
  // noisy and no score can be trusted, so abort before anything is scored.
  const aaScores: number[] = [];
  for (let i = 0; i < k; i++) {
    const score = await judgeOne(planted.taskPrompt, planted.goldText, judge, model);
    aaScores.push(score.overall);
  }
  const aa = aaJudgeStability(aaScores, tol);
  if (!aa.ok) {
    return emit(opts.outPath, buildAbortedArtifact(aa.verdict!));
  }

  // (b) planted discrimination — the judge must score the hand-authored GOLD high and POOR low (GOLD > POOR).
  // If it cannot separate a planted quality gap, it cannot judge a real one, so abort before scoring inputs.
  const goldScore = await judgeOne(planted.taskPrompt, planted.goldText, judge, model);
  const poorScore = await judgeOne(planted.taskPrompt, planted.poorText, judge, model);
  const discrimination = plantedDiscrimination(goldScore.overall, poorScore.overall, goldMin, poorMax);
  if (!discrimination.ok) {
    return emit(opts.outPath, buildAbortedArtifact(discrimination.verdict!));
  }

  // (c) ONLY NOW — score each real input artifact; the gates have proven the judge is stable and discriminating.
  const scored: ScoredArtifact[] = [];
  for (const input of opts.artifacts) {
    const score = await judgeOne(input.taskPrompt, input.artifactText, judge, model);
    scored.push({ taskId: input.taskId, score });
  }
  const artifact = buildScoredArtifact(scored, {
    aaStdev: aa.stdev,
    aaScores,
    goldOverall: goldScore.overall,
    poorOverall: poorScore.overall,
  });
  return emit(opts.outPath, artifact);
}

/** Write the artifact and package the result (single exit point keeps the write in one place). */
function emit(outPath: string, artifact: QualityArtifact): QualityResult {
  writeArtifact(outPath, artifact);
  return { artifact, outPath };
}
