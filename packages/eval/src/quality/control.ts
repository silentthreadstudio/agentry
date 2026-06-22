// The decision-quality CONTROL layer (design §3) — two PURE predicates over judge scores that make a flattering
// judge structurally impossible. A judge that can hand out generous scores is worthless, so the same
// controls-as-structure discipline as routing/control.ts gates it: the predicates take only numbers and return
// verdicts; they do ZERO I/O and call no API, so each is forced-testable with synthetic score arrays. The probe
// (probe.ts) SEQUENCES these gates before any artifact is scored; this module only DEFINES them.
//
// Why these two, and what each guards against (mirroring routing's negative + positive controls):
//   - aaJudgeStability (the NEGATIVE control) — judge the SAME artifact k times; the overall scores must agree
//                       within a tolerance. A judge that scatters on identical input measures noise, not quality.
//   - plantedDiscrimination (the POSITIVE control) — a hand-authored GOLD artifact must score HIGH and a
//                       hand-authored POOR artifact must score LOW, with GOLD clearly > POOR. A judge that
//                       cannot separate a planted quality gap never catches a real one.

import { stdev } from "../stats.ts";

/**
 * The verdict string each control emits on failure. PINNED — the artifact and probe consume them verbatim, so
 * the literals are the contract and must never drift (design §3).
 */
export type AaJudgeVerdict = "judge-measures-noise";
export type DiscriminationVerdict = "judge-cannot-discriminate";

/** Default tolerance (population stdev) for the A/A judge-stability null — scores within this agree (design §3). */
export const DEFAULT_AA_TOLERANCE = 0.1;

/** Result of the A/A judge-stability control. `ok` true iff the repeated overall scores agree within `tol`. */
export interface AaJudgeResult {
  ok: boolean;
  verdict?: AaJudgeVerdict;
  /** The population standard deviation of the observed overall scores (for the artifact readout). */
  stdev: number;
}

/** Result of the planted-discrimination control. `ok` true iff GOLD scored high, POOR low, and GOLD > POOR. */
export interface DiscriminationResult {
  ok: boolean;
  verdict?: DiscriminationVerdict;
}

/**
 * The A/A NEGATIVE control (design §3). Given the OVERALL scores from judging the SAME artifact `k` times,
 * agreement within `tol` (population stdev ≤ `tol`) is the expected null; a wider spread means the judge
 * measures noise and the run must abort with no score.
 *
 * @param scores the per-repeat overall scores (one entry per A/A repeat).
 * @param tol    the max population stdev that still counts as agreement — defaults to {@link DEFAULT_AA_TOLERANCE}.
 *               Kept a parameter, not a hard-coded constant, so the design's "same 0.2-width bucket OR stdev≤tol"
 *               tolerance is one place to tune.
 * @returns `{ ok: true, stdev }` when the scores agree within `tol`; otherwise
 *          `{ ok: false, verdict: 'judge-measures-noise', stdev }`. An empty/singleton set has stdev 0 (it
 *          trivially agrees — there is no spread to contradict the null), so a degenerate A/A run is treated as
 *          stable; the probe is responsible for supplying `k` real repeats.
 */
export function aaJudgeStability(scores: readonly number[], tol: number = DEFAULT_AA_TOLERANCE): AaJudgeResult {
  const sd = stdev(scores);
  return sd <= tol
    ? { ok: true, stdev: sd }
    : { ok: false, verdict: "judge-measures-noise", stdev: sd };
}

/**
 * The planted POSITIVE control (design §3). A hand-authored GOLD artifact must score HIGH (overall ≥ `goldMin`)
 * and a hand-authored POOR artifact must score LOW (overall ≤ `poorMax`), AND GOLD must beat POOR. All three
 * clauses must hold: a judge that scores GOLD high but also scores POOR high (no separation), or that inverts
 * them, cannot tell good from bad and the run aborts.
 *
 * @param goldOverall the judge's overall for the planted GOLD artifact.
 * @param poorOverall the judge's overall for the planted POOR artifact.
 * @param goldMin     the floor GOLD must clear.
 * @param poorMax     the ceiling POOR must stay under.
 * @returns `{ ok: true }` when `goldOverall >= goldMin AND poorOverall <= poorMax AND goldOverall > poorOverall`;
 *          otherwise `{ ok: false, verdict: 'judge-cannot-discriminate' }`.
 */
export function plantedDiscrimination(
  goldOverall: number,
  poorOverall: number,
  goldMin: number,
  poorMax: number,
): DiscriminationResult {
  const ok = goldOverall >= goldMin && poorOverall <= poorMax && goldOverall > poorOverall;
  return ok ? { ok: true } : { ok: false, verdict: "judge-cannot-discriminate" };
}
