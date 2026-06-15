// The control layer (AC6–AC8 / OQ4) — the load-bearing part of the self-eval: three PURE predicates over
// observed *dispatched* shapes that make a misaimed eval structurally impossible. They take only `Shape`
// values (the dispatched-shape vocabulary from shape.ts) and return verdicts; they do ZERO I/O and call no
// API, so each is forced-testable with synthetic shape arrays. The probe (T-5) SEQUENCES these gates in the
// gated order (ADR-004); this module only DEFINES them.
//
// Why these three, and what each guards against (per the eval-methodology memory g:01KV4QTQ42C2BX1MY76Z80AJ74):
//   - aaUnanimity   (AC6 / OQ4) — the NEGATIVE control: the same task run k times must route the same way.
//                                  A split means the instrument measures noise, not signal — fail, no score.
//   - positiveControl (AC7)     — the POSITIVE control: a hard-coded, known-correct case the instrument MUST
//                                  catch. If it can't catch a planted difference, it never catches a real one.
//   - saturationGuard (AC8)     — the DISCRIMINATING-POWER guard: if every observed run collapses to ONE
//                                  shape, the rubric has no spread to measure — abort before any accuracy
//                                  number is computed. It watches DISPATCHED-shape spread, NOT labeled-floor
//                                  spread (the labeled set spans shapes by construction; only a rubric that
//                                  flattens every task to one shape trips this — the failure mode worth catching).

import type { Shape } from "./shape.ts";

/** The number of A/A repeats whose unanimity defines the negative control's null (OQ4: 3). */
export const DEFAULT_AA_REPEATS = 3;

/**
 * The verdict string each control emits on failure. PINNED — the artifact and probe consume them verbatim,
 * so the literals are the contract and must never drift.
 */
export type AaVerdict = "instrument-measures-noise";
export type PositiveControlVerdict = "positive-control-missed";
export type SaturationVerdict = "no-discriminating-power";

/** Result of the A/A negative control. `ok` true iff all `k` repeats dispatched the identical shape. */
export interface AaResult {
  ok: boolean;
  verdict?: AaVerdict;
}

/** Result of the planted positive control. `ok` true iff the observed shape matches the planted one. */
export interface PositiveControlResult {
  ok: boolean;
  verdict?: PositiveControlVerdict;
}

/** Result of the saturation guard. `power` true iff the observed shapes spread across ≥2 distinct shapes. */
export interface SaturationResult {
  power: boolean;
  verdict?: SaturationVerdict;
}

/**
 * AC6 / OQ4 — the A/A NEGATIVE control. Given the dispatched shapes from running the SAME task `k` times,
 * unanimity (all `k` identical) is the expected null; any split means the instrument measures noise and the
 * run must fail with no score.
 *
 * @param shapes the per-repeat dispatched shapes (one entry per A/A repeat).
 * @param k      the required number of repeats — defaults to {@link DEFAULT_AA_REPEATS} (3). Kept a parameter,
 *               not a hard-coded 3, because OQ4 may later relax the tolerance to "≥ threshold over a larger k";
 *               the call sites pass `k` so that relaxation is a one-place config change, never a scatter of 3s.
 * @returns `{ ok: true }` when all `k` repeats are identical; otherwise
 *          `{ ok: false, verdict: 'instrument-measures-noise' }` (a wrong repeat count OR a non-unanimous set
 *          both fail — an A/A run that didn't produce `k` comparable repeats can't establish the null).
 */
export function aaUnanimity(shapes: Shape[], k: number = DEFAULT_AA_REPEATS): AaResult {
  // A malformed A/A run (not exactly k repeats) cannot establish unanimity — treat as instrument failure.
  if (shapes.length !== k) {
    return { ok: false, verdict: "instrument-measures-noise" };
  }
  const allIdentical = shapes.every((shape) => shape === shapes[0]);
  return allIdentical ? { ok: true } : { ok: false, verdict: "instrument-measures-noise" };
}

/**
 * AC7 — the planted POSITIVE control. A fixture with a hard-coded, guaranteed-correct shape the instrument
 * MUST detect: the observed (extracted) shape has to equal the planted one. A mismatch means the plumbing is
 * broken — if the instrument can't catch a hard-coded difference it never catches a real one — so the run
 * fails loudly.
 *
 * @param planted  the known-correct shape the control case is guaranteed to be.
 * @param observed the shape the extractor actually produced for that case.
 * @returns `{ ok: true }` when `observed === planted`; otherwise
 *          `{ ok: false, verdict: 'positive-control-missed' }`.
 */
export function positiveControl(planted: Shape, observed: Shape): PositiveControlResult {
  return observed === planted
    ? { ok: true }
    : { ok: false, verdict: "positive-control-missed" };
}

/**
 * AC8 — the saturation / no-discriminating-power guard. Watches the spread of the *dispatched* shapes the
 * instrument actually observed (NOT the labeled-floor spread — that spans shapes by construction). If every
 * observed run collapsed to a SINGLE distinct shape, the instrument has no discriminating power and the
 * ladder must abort BEFORE any accuracy is computed; ≥2 distinct shapes means there is spread to measure.
 *
 * @param observed the dispatched shapes observed across the labeled run (one per task).
 * @returns `{ power: false, verdict: 'no-discriminating-power' }` when all observed shapes are the same single
 *          shape (or none were observed); otherwise `{ power: true }`.
 */
export function saturationGuard(observed: Shape[]): SaturationResult {
  const distinct = new Set<Shape>(observed);
  return distinct.size >= 2
    ? { power: true }
    : { power: false, verdict: "no-discriminating-power" };
}
