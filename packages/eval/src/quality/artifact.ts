// The decision-quality ARTIFACT (design §5) — the shape the quality probe emits and the render to disk. This
// module owns ONLY the result data structure + serialization; the probe (probe.ts) owns the gated control flow
// that DECIDES whether any artifact is scored. Two artifact conditions exist, mirroring routing/artifact.ts:
//   - an ABORTED run (a control gate fired): the artifact carries the firing control's verdict and NO scores —
//     `scores` is absent. This is the design §3/§5 contract made observable: a reader can see the abort and see
//     that no quality number was emitted.
//   - a SCORED run (both gates passed): per-artifact scores (each dimension's 0/1/2 breakdown + the overall),
//     the overall mean across artifacts, plus the control readouts (the A/A stability distribution + the planted
//     GOLD/POOR overalls that proved the judge can discriminate).

import { writeFileSync } from "node:fs";

import { mean } from "../stats.ts";
import { QUALITY_DIMENSIONS } from "./rubric.ts";
import type { QualityScore } from "./judge.ts";

/** One scored input artifact: its task id and the judge's structured verdict (dimensions + overall + rationale). */
export interface ScoredArtifact {
  taskId: string;
  score: QualityScore;
}

/**
 * The control readouts attached to a SCORED run — the evidence the gates passed, so a reader trusts the scores.
 *   - `aaStdev` is the population stdev of the A/A repeats (≤ tolerance, or the gate would have fired);
 *   - `aaScores` is the per-repeat overall scores that produced it (the negative control's raw data);
 *   - `goldOverall` / `poorOverall` are the planted fixtures' overalls (GOLD high, POOR low — the positive control).
 */
export interface QualityControls {
  aaStdev: number;
  aaScores: readonly number[];
  goldOverall: number;
  poorOverall: number;
}

/**
 * The emitted artifact. `condition` describes the eval's terminal state:
 *   - `"aborted"` — a control gate fired; `abortVerdict` carries the pinned verdict; `scores`/`overallMean`/
 *     `controls` are ABSENT (no quality number when a gate fires — design §3).
 *   - `"scored"` — both gates passed; `scores`, `overallMean`, and `controls` are populated.
 */
export interface QualityArtifact {
  condition: "aborted" | "scored";
  /** The pinned verdict of the control that aborted the run (only on `condition === "aborted"`). */
  abortVerdict?: string;
  /** Per-artifact judge verdicts (dimension breakdown + overall + rationale); absent on an aborted run. */
  scores?: ScoredArtifact[];
  /** Mean of the per-artifact `overall` scores (0 when no artifacts); absent on an aborted run. */
  overallMean?: number;
  /** The control evidence (A/A stability + planted discrimination); absent on an aborted run. */
  controls?: QualityControls;
}

/**
 * Build the SCORED artifact (the probe calls this only AFTER both control gates have passed). It carries each
 * input artifact's per-dimension breakdown + overall, the overall MEAN across artifacts, and the control
 * readouts that prove the judge was trustworthy on this run. The dimension order is pinned to
 * {@link QUALITY_DIMENSIONS} so the rendered JSON is stable across runs.
 */
export function buildScoredArtifact(
  scored: readonly ScoredArtifact[],
  controls: QualityControls,
): QualityArtifact {
  // Re-key each dimensions object in the canonical order so the serialized artifact is deterministic.
  const scores: ScoredArtifact[] = scored.map((s) => {
    const dimensions = {} as QualityScore["dimensions"];
    for (const d of QUALITY_DIMENSIONS) dimensions[d] = s.score.dimensions[d];
    return { taskId: s.taskId, score: { ...s.score, dimensions } };
  });
  return {
    condition: "scored",
    scores,
    overallMean: mean(scores.map((s) => s.score.overall)),
    controls,
  };
}

/**
 * Build the ABORTED artifact (design §3/§5): a control gate fired, so NO scores / mean / controls are produced —
 * only the firing control's pinned verdict. The absence of `scores` is the observable proof that judging did not
 * run on the real artifacts.
 */
export function buildAbortedArtifact(abortVerdict: string): QualityArtifact {
  return { condition: "aborted", abortVerdict };
}

/** Serialize the artifact to pretty JSON at `path`. Returns the path written (the command echoes it to stdout). */
export function writeArtifact(path: string, artifact: QualityArtifact): string {
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return path;
}
