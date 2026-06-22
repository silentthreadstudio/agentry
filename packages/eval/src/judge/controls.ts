// The shared CONTROL layer (ADR-002/003) — two PURE predicates over judge scores that make a flattering judge
// structurally impossible, generalized from `outcome-judge/control.ts` so EVERY probe gates through one pair. A
// judge that can hand out generous scores is worthless, so the controls-as-structure discipline gates it: the
// predicates take only numbers and return verdicts; they do ZERO I/O and call no API, so each is forced-testable
// with synthetic score arrays. A probe SEQUENCES these gates before any scoring runs; this module only DEFINES
// them.
//
// Why these two, and what each guards against (the negative + positive controls):
//   - aaStability (the NEGATIVE control) — judge the SAME subject k times; the overall scores must agree within a
//                 tolerance. A judge that scatters on identical input measures noise, not quality.
//   - discrimination (the POSITIVE control) — a known-correct `gold` subject must score HIGH and a planted-wrong
//                 `broken` subject must score LOW, with GOLD clearly > BROKEN by an explicit minimum GAP. A judge
//                 that cannot separate a planted gap never catches a real one.
//
// The verdict literals carry a `<subject>-judge-…` shape; each probe passes its own subject label so the
// artifact/report surface the same pinned strings the per-probe code consumed before the lift (e.g.
// "outcome-judge-measures-noise"). The literals are the contract and must never drift (ADR-003).

import { stdev } from "../stats.ts";

/** Default tolerance (population stdev) for the A/A stability null — scores within this agree (ADR-003). */
export const DEFAULT_AA_TOLERANCE = 0.1;

/** Default floor the `gold` overall must clear (ADR-003 — conservative floor vs the validated 1.0 gold). */
export const DEFAULT_GOLD_MIN = 0.7;

/** Default ceiling the `broken` overall must stay under (ADR-003 — conservative vs the validated 0.2 poor). */
export const DEFAULT_BROKEN_MAX = 0.4;

/** Default minimum gold − broken gap required (ADR-003 — the explicit separation clause on top of the bounds). */
export const DEFAULT_MIN_GAP = 0.3;

/**
 * Minimum repeats the discrimination control judges gold/broken before comparing MEANS (ADR-003). The judge has
 * real per-draw variance (a tidy-but-wrong `broken` subject legitimately floats ~0.25–0.5 across draws), so a
 * single-draw gate flakes false-negative even though the means separate cleanly. Averaging over ≥ this many draws
 * is measurement-noise reduction — NOT threshold-loosening — and mirrors the matrix's own k-fold averaging. The
 * probe uses `max(matrix k, this)`, so the gate stays robust even on a `k=1` slice.
 */
export const DEFAULT_CONTROL_REPEATS = 3;

/** Result of the A/A stability control. `ok` true iff the repeated overall scores agree within `tol`. */
export interface AaResult {
  ok: boolean;
  /** The pinned `<subject>-judge-measures-noise` verdict, present only when the control fires. */
  verdict?: string;
  /** The population standard deviation of the observed overall scores (for the artifact readout). */
  stdev: number;
}

/** Result of the gold/broken discrimination control. `ok` true iff GOLD scored high, BROKEN low, gap ≥ minGap. */
export interface DiscriminationResult {
  ok: boolean;
  /** The pinned `<subject>-judge-cannot-discriminate` verdict, present only when the control fires. */
  verdict?: string;
}

/** The A/A failure verdict string for a given subject label (e.g. "outcome" => "outcome-judge-measures-noise"). */
export function aaVerdict(subject: string): string {
  return `${subject}-judge-measures-noise`;
}

/** The discrimination failure verdict string for a subject label (e.g. "outcome-judge-cannot-discriminate"). */
export function discriminationVerdict(subject: string): string {
  return `${subject}-judge-cannot-discriminate`;
}

/**
 * The A/A NEGATIVE control (ADR-003). Given the OVERALL scores from judging the SAME subject `k` times, agreement
 * within `tol` (population stdev ≤ `tol`) is the expected null; a wider spread means the judge measures noise and
 * the run must abort with no score.
 *
 * @param scores  the per-repeat overall scores (one entry per A/A repeat).
 * @param tol     the max population stdev that still counts as agreement — defaults to {@link DEFAULT_AA_TOLERANCE}.
 * @param subject the verdict label (e.g. "outcome") used to stamp the pinned `<subject>-judge-measures-noise`
 *                string the artifact consumes verbatim.
 * @returns `{ ok: true, stdev }` when the scores agree within `tol`; otherwise
 *          `{ ok: false, verdict, stdev }`. An empty/singleton set has stdev 0 (it trivially agrees — no spread to
 *          contradict the null), so a degenerate A/A run is treated as stable; the probe supplies `k` real repeats.
 */
export function aaStability(
  scores: readonly number[],
  tol: number = DEFAULT_AA_TOLERANCE,
  subject = "outcome",
): AaResult {
  const sd = stdev(scores);
  return sd <= tol ? { ok: true, stdev: sd } : { ok: false, verdict: aaVerdict(subject), stdev: sd };
}

/**
 * The gold/broken POSITIVE control (ADR-003). A known-correct `gold` subject must score HIGH (overall ≥ `goldMin`)
 * and a planted-wrong `broken` subject must score LOW (overall ≤ `brokenMax`), AND GOLD must beat BROKEN by an
 * explicit minimum GAP (`gold − broken ≥ minGap`). All clauses must hold: a judge that scores GOLD high but also
 * scores BROKEN high (no separation), that inverts them, or that leaves only a collapsed gap, cannot tell good
 * from bad and the run aborts.
 *
 * The `minGap` clause is the explicit separation on top of the bounds (ADR-003): a near-tie that still technically
 * clears the bounds (e.g. gold 0.8, broken 0.7) is rejected as too weak a separation.
 *
 * @param gold      the judge's overall for the `gold` subject.
 * @param broken    the judge's overall for the `broken` subject.
 * @param goldMin   the floor GOLD must clear — defaults to {@link DEFAULT_GOLD_MIN}.
 * @param brokenMax the ceiling BROKEN must stay under — defaults to {@link DEFAULT_BROKEN_MAX}.
 * @param minGap    the minimum required `gold − broken` separation — defaults to {@link DEFAULT_MIN_GAP}.
 * @param subject   the verdict label used to stamp the pinned `<subject>-judge-cannot-discriminate` string.
 * @returns `{ ok: true }` when all clauses hold; otherwise `{ ok: false, verdict }`.
 */
export function discrimination(
  gold: number,
  broken: number,
  goldMin: number = DEFAULT_GOLD_MIN,
  brokenMax: number = DEFAULT_BROKEN_MAX,
  minGap: number = DEFAULT_MIN_GAP,
  subject = "outcome",
): DiscriminationResult {
  const ok = gold >= goldMin && broken <= brokenMax && gold > broken && gold - broken >= minGap;
  return ok ? { ok: true } : { ok: false, verdict: discriminationVerdict(subject) };
}
