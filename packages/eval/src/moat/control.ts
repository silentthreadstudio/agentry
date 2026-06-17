// The moat dimension's control layer — pure gates that make a misaimed memory-hygiene measurement structurally
// impossible, mirroring the routing controls. Two gates, sequenced by the probe BEFORE any compound score:
//
//   - seedLandingGuard (VALIDITY / negative) — every warm-relevant run must have RECALLED a non-empty store. If a
//     seed didn't land (a rooting/format bug), the run says nothing about compounding → fail, no score. This is
//     the SEED-MISS that cost the throwaway probe several live runs, now a first-class gate.
//   - discriminationGuard (POWER / positive) — the relevant fact must compound where an IRRELEVANT decoy does not.
//     If the decoy lightens the shape as often as the relevant fact, "compounding" is memory-AGNOSTIC (the
//     conductor just routes lighter on a warm run) → no discriminating power → fail. And if NOTHING compounds, the
//     instrument detected no effect to measure → fail.
//
// SRP: pure predicates over booleans/shapes. Zero I/O, no API — forced-testable with synthetic arrays.

/** The verdict literals each gate emits on failure. PINNED — the artifact/probe consume them verbatim. */
export type SeedLandingVerdict = "seed-did-not-land";
export type DiscriminationVerdict = "no-compounding-detected" | "memory-agnostic-lightening";

/** Result of the seed-landing validity gate. `ok` iff every warm-relevant run recalled the seed. */
export interface SeedLandingResult {
  ok: boolean;
  verdict?: SeedLandingVerdict;
  /** How many of the relevant runs landed their seed (for the artifact / diagnostics). */
  landedCount: number;
  total: number;
}

/** Result of the discrimination power gate. `power` iff relevant compounds and the decoy does not (enough). */
export interface DiscriminationResult {
  power: boolean;
  verdict?: DiscriminationVerdict;
  compoundRate: number;
  decoyLightenRate: number;
}

/**
 * VALIDITY gate. Every warm-relevant run must have landed its seed (recall non-empty). A single miss invalidates
 * the run: an unseeded warm run can't show compounding, so a partial seed set would bias the rate. Strict by
 * design (like routing's A/A unanimity) — relax to a threshold later via a param if needed.
 */
export function seedLandingGuard(landed: readonly boolean[]): SeedLandingResult {
  const landedCount = landed.filter(Boolean).length;
  const total = landed.length;
  const ok = total > 0 && landedCount === total;
  return ok ? { ok, landedCount, total } : { ok, verdict: "seed-did-not-land", landedCount, total };
}

/**
 * POWER gate. `compounded[i]`/`decoyLightened[i]` are the per-task outcomes: did the RELEVANT fact make task i
 * route lighter than its cold floor, and did the DECOY also lighten it? The instrument has discriminating power
 * iff at least one task compounded AND the decoy lightens strictly less often than the relevant fact does — i.e.
 * the lightening is attributable to the RELEVANT memory, not to merely being a warm run.
 */
export function discriminationGuard(
  compounded: readonly boolean[],
  decoyLightened: readonly boolean[],
): DiscriminationResult {
  const n = compounded.length;
  const compoundRate = n === 0 ? 0 : compounded.filter(Boolean).length / n;
  const decoyLightenRate = n === 0 ? 0 : decoyLightened.filter(Boolean).length / n;

  if (compoundRate === 0) {
    return { power: false, verdict: "no-compounding-detected", compoundRate, decoyLightenRate };
  }
  if (decoyLightenRate >= compoundRate) {
    return { power: false, verdict: "memory-agnostic-lightening", compoundRate, decoyLightenRate };
  }
  return { power: true, compoundRate, decoyLightenRate };
}
