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

/** The default seed-landing rate FLOOR — the instrument must have exercised memory on a MAJORITY of relevant runs. */
export const DEFAULT_SEED_LANDING_FLOOR = 0.5;

/** Result of the seed-landing validity gate. `ok` iff the landing RATE cleared the floor. */
export interface SeedLandingResult {
  ok: boolean;
  verdict?: SeedLandingVerdict;
  /** How many of the relevant runs landed their seed (for the artifact / diagnostics). */
  landedCount: number;
  total: number;
  /** The measured landing rate (`landedCount / total`; 0 when there were no relevant runs). */
  rate: number;
  /** The floor the rate had to clear (for diagnostics). */
  floor: number;
}

/** Result of the discrimination power gate. `power` iff relevant compounds and the decoy does not (enough). */
export interface DiscriminationResult {
  power: boolean;
  verdict?: DiscriminationVerdict;
  compoundRate: number;
  decoyLightenRate: number;
}

/**
 * VALIDITY gate — a RATE FLOOR over the warm-relevant repeats. With k>1 the per-run recall is stochastic, so an
 * all-or-nothing rule would abort on a single transient miss; instead the landing RATE must clear `floor` (default
 * {@link DEFAULT_SEED_LANDING_FLOOR} = 0.5 — the instrument must have exercised memory on a MAJORITY of relevant
 * repeats, or the measurement is too weak to trust). The mandatory-recall directive keeps this high; the floor is a
 * safety net. Below the floor (or with no relevant runs) ⇒ `seed-did-not-land`, no score.
 */
export function seedLandingGuard(
  landed: readonly boolean[],
  floor: number = DEFAULT_SEED_LANDING_FLOOR,
): SeedLandingResult {
  const landedCount = landed.filter(Boolean).length;
  const total = landed.length;
  const rate = total === 0 ? 0 : landedCount / total;
  const ok = total > 0 && rate >= floor;
  return ok
    ? { ok, landedCount, total, rate, floor }
    : { ok, verdict: "seed-did-not-land", landedCount, total, rate, floor };
}

/**
 * POWER gate, evaluated over the AGGREGATED rates (k-aware). `compoundRate` is "given recall fired, how often the
 * relevant fact collapsed the fork" (over the LANDED relevant repeats); `decoyLightenRate` is the irrelevant-fact
 * false-positive base rate (over ALL decoy repeats). The instrument has discriminating power iff SOMETHING compounded
 * AND the relevant fact lightens strictly MORE than the decoy does — i.e. the lightening is attributable to the
 * RELEVANT memory, not to merely being a warm run. Nothing compounds ⇒ `no-compounding-detected`; the decoy lightens
 * at least as often ⇒ `memory-agnostic-lightening`.
 */
export function discriminationGuard(compoundRate: number, decoyLightenRate: number): DiscriminationResult {
  if (compoundRate === 0) {
    return { power: false, verdict: "no-compounding-detected", compoundRate, decoyLightenRate };
  }
  if (decoyLightenRate >= compoundRate) {
    return { power: false, verdict: "memory-agnostic-lightening", compoundRate, decoyLightenRate };
  }
  return { power: true, compoundRate, decoyLightenRate };
}
