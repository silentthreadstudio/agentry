// The moat (memory-hygiene) artifact — the shape the probe emits and renders to disk. Like the routing artifact,
// it has two terminal conditions: ABORTED (a control gate fired — no compound score, only the verdict) and SCORED
// (gates passed — the compound rate, the decoy contrast, and the per-task census). This module owns ONLY the data
// structure + scoring math; `probe.ts` owns the gated control flow that decides whether a number is produced.
//
// The single measured quantity: did a prior decision in memory make a task route LIGHTER than its cold floor?
// "Lighter" is read off the shared shape-weight order (one-shot < spec-first < decompose), so this dimension
// reuses the routing vocabulary rather than inventing its own.

import { writeFileSync } from "node:fs";

import type { Shape } from "../conduct/shape.ts";
import { SHAPES_BY_WEIGHT } from "../conduct/shape.ts";
import { mean, stdev } from "../stats.ts";

/** One warm run's result: the dispatched shape (null = degenerate/indeterminate) and whether recall landed the seed. */
export interface WarmRun {
  shape: Shape | null;
  landed: boolean;
  /**
   * RESULT-QUALITY gate (relevant arm only): when this run routed LIGHTER than the cold floor (it one-shot, so it
   * settled and left a produced tree), the tree is judged for whether it meets intent AND applies the recalled
   * decision — `true` iff the judged overall cleared the GOOD bar. ABSENT (undefined) on the decoy arm and on any
   * relevant run that did NOT route lighter (nothing one-shot ⇒ no tree to judge ⇒ no result-gate to apply). A
   * route-lighter relevant run is "compounded" ONLY when this is `true` — a lighter-but-BAD result is NOT a moat win.
   */
  resultGood?: boolean;
  /** The judged overall (0..1) behind {@link resultGood}, carried for the census readout; absent when not judged. */
  resultOverall?: number;
}

/** One task's full moat outcome: its cold floor + the two warm runs (relevant fork-resolver, irrelevant decoy). */
export interface MoatOutcome {
  taskId: string;
  /** The shape the task routes to with EMPTY memory (the labeled baseline). */
  coldFloor: Shape;
  /** Warm run with the fork-resolving fact seeded. */
  relevant: WarmRun;
  /** Warm run with an irrelevant decoy fact seeded (the discrimination control). */
  decoy: WarmRun;
}

/**
 * Per-(task, repeat) census row — the readable trace of ONE repeat's compounding behavior. With k>1 a task has k of
 * these per arm; the aggregator rolls them up into a {@link MoatTaskCensus}. Per-repeat conducting is stochastic, so
 * this single-draw view is never the headline; it is the raw grain the rates and the spread are computed from.
 */
export interface MoatCensusRow {
  taskId: string;
  coldFloor: Shape;
  warmRelevant: Shape | null;
  warmDecoy: Shape | null;
  landedRelevant: boolean;
  landedDecoy: boolean;
  /** Relevant memory recalled AND routed lighter than the cold floor AND the produced result was judged GOOD. */
  compounded: boolean;
  /**
   * The HONEST-failure signal: relevant memory recalled AND routed lighter than the cold floor BUT the produced
   * result was judged BAD (`resultGood === false`). Memory lightened the route but the code failed — NOT a win, and
   * never silently dropped or mis-counted as one.
   */
  lighterButBad: boolean;
  /** The decoy did NOT lighten the shape (the control held). */
  decoyHeld: boolean;
}

/**
 * Per-task census in the scored artifact — the k repeats of one task rolled into FRACTIONS (never a bare point —
 * the honesty rule). Conducting is stochastic, so each fraction carries the count it was computed over plus a spread
 * readout so a reader sees the variance behind the headline.
 */
export interface MoatTaskCensus {
  taskId: string;
  coldFloor: Shape;
  /** How many relevant repeats LANDED their seed (the compound denominator for this task). */
  landedRepeats: number;
  /** Total relevant repeats run for this task (k). */
  repeats: number;
  /**
   * Fraction of LANDED relevant repeats that routed lighter AND produced a GOOD result (the results-gated compound);
   * null when none landed (no basis). A lighter-but-BAD repeat is NOT counted here — it lands in
   * {@link lighterButBadFraction} instead.
   */
  relevantCompoundedFraction: number | null;
  /**
   * Fraction of LANDED relevant repeats that routed lighter than the cold floor but produced a BAD result (memory
   * lightened the route, the code failed). The honest "lightened but broken" signal, surfaced so it is visible and
   * never mis-counted as a compound. Null when none landed (no basis).
   */
  lighterButBadFraction: number | null;
  /** Fraction of decoy repeats that routed lighter than the cold floor (the control — should be ~0). */
  decoyLightenedFraction: number;
  /** Fraction of relevant repeats that landed their seed (this task's validity readout). */
  seedLandedFraction: number;
  /** Population stdev of the per-repeat compounded indicator over the LANDED relevant repeats (the spread). */
  compoundedSpread: number;
}

/** The early-signal caveat — small N is directional, not a powered estimate. PINNED. */
export const MOAT_CAVEAT =
  "Early-signal: a directional read of whether recalled memory makes a task route lighter (compounding), " +
  "NOT a powered estimate — controls (seed-landing + decoy discrimination) gate every number shown.";

/**
 * The emitted artifact. `condition`:
 *   - `"aborted"` — a control gate fired; `abortVerdict` carries the pinned verdict; `compoundRate` is `null` and
 *     the rate/contrast/census are ABSENT (no number when a gate fires).
 *   - `"scored"` — gates passed; `compoundRate`, `decoyLightenRate`, `discrimination`, and `census` are populated.
 */
export interface MoatArtifact {
  condition: "aborted" | "scored";
  /** The pinned verdict of the gate that aborted the run (only on `condition === "aborted"`). */
  abortVerdict?: string;
  /**
   * GIVEN recall fired, how often the recalled fact collapsed the fork: relevant repeats that LANDED and routed
   * lighter than the cold floor, over relevant repeats that LANDED (the INDETERMINATE non-landed repeats are
   * excluded from BOTH numerator and denominator). `null` on abort; 0 when no relevant repeat landed.
   */
  compoundRate: number | null;
  /**
   * The HONEST-failure rate: relevant repeats that LANDED and routed lighter but produced a BAD result, over relevant
   * repeats that LANDED (same denominator as {@link compoundRate} — the landed set). Surfaces the "memory lightened
   * the route but the code failed" case so a route-only lighter count is never mistaken for a compound win; absent on
   * abort, 0 when no relevant repeat landed.
   */
  lighterButBadRate?: number;
  /** Fraction of ALL decoy repeats that routed lighter than the cold floor — the false-positive base rate (no landing filter); absent on abort. */
  decoyLightenRate?: number;
  /** `compoundRate − decoyLightenRate` — the memory-attributable lightening (the clean signal); absent on abort. */
  discrimination?: number;
  /** Relevant repeats that landed their seed, over ALL relevant repeats — the validity readout; absent on abort. */
  seedLandingRate?: number;
  /** Raw landing counts behind {@link seedLandingRate} (the auditable denominator); absent on abort. */
  seedLanding?: { landedCount: number; total: number };
  /** The repeat count k this run used (1 = a single high-variance draw); absent on abort. */
  runs?: number;
  /** Per-task census (the k repeats rolled into fractions + spread); absent on abort. */
  census?: MoatTaskCensus[];
  /** Always-present directional caveat. */
  earlySignalCaveat: string;
}

/** Index in the weight order (one-shot=0, spec-first=1, decompose=2). */
function weight(shape: Shape): number {
  return SHAPES_BY_WEIGHT.indexOf(shape);
}

/** Did a warm run route LIGHTER than the cold floor? (recalled-and-applied makes the task need less process.) */
function lighterThanFloor(run: WarmRun, coldFloor: Shape): boolean {
  return run.shape !== null && weight(run.shape) < weight(coldFloor);
}

/** Build the per-(task, repeat) census row from one outcome (the compounding/decoy-held booleans the aggregator folds). */
export function censusRow(o: MoatOutcome): MoatCensusRow {
  const decoyHeld = !lighterThanFloor(o.decoy, o.coldFloor);
  return {
    taskId: o.taskId,
    coldFloor: o.coldFloor,
    warmRelevant: o.relevant.shape,
    warmDecoy: o.decoy.shape,
    landedRelevant: o.relevant.landed,
    landedDecoy: o.decoy.landed,
    compounded: relevantCompounded(o),
    lighterButBad: relevantLighterButBad(o),
    decoyHeld,
  };
}

/**
 * Whether ONE relevant repeat compounded — the RESULTS-GATED definition: landed its seed AND routed lighter than the
 * cold floor AND the judged result was GOOD (`resultGood === true`). A lighter route alone is NOT enough — memory
 * could lighten the route into a BROKEN one-shot; only a lighter route that PRODUCED a working result (applying the
 * recalled decision) is a moat win. A relevant run that did not route lighter never carries `resultGood` (nothing
 * one-shot to judge), so the `=== true` check correctly excludes it.
 */
function relevantCompounded(o: MoatOutcome): boolean {
  return o.relevant.landed && lighterThanFloor(o.relevant, o.coldFloor) && o.relevant.resultGood === true;
}

/**
 * Whether ONE relevant repeat LIGHTENED-BUT-FAILED — landed its seed AND routed lighter than the cold floor BUT the
 * judged result was BAD (`resultGood === false`). The honest "memory lightened the route, the code failed" signal:
 * counted distinctly from {@link relevantCompounded} so it is never silently dropped nor mis-scored as a win.
 */
function relevantLighterButBad(o: MoatOutcome): boolean {
  return o.relevant.landed && lighterThanFloor(o.relevant, o.coldFloor) && o.relevant.resultGood === false;
}

/** Whether ONE decoy repeat lightened — routed lighter than the cold floor (the false-positive event). */
function decoyLightened(o: MoatOutcome): boolean {
  return lighterThanFloor(o.decoy, o.coldFloor);
}

/**
 * Roll a task's k repeats (all the outcomes sharing its `taskId`) into a {@link MoatTaskCensus} of fractions + a
 * spread. The compound fraction is computed over the LANDED relevant repeats ONLY — a non-landed repeat is
 * INDETERMINATE (recall never fired, so it says nothing about compounding), excluded from numerator AND denominator;
 * `null` when no relevant repeat landed (no basis). Decoy and seed-landing fractions span ALL repeats.
 */
export function taskCensus(repeats: readonly MoatOutcome[]): MoatTaskCensus {
  const first = repeats[0]!;
  const n = repeats.length;
  const landed = repeats.filter((o) => o.relevant.landed);
  const compoundedIndicators = landed.map((o) => (relevantCompounded(o) ? 1 : 0));
  const lighterButBadIndicators = landed.map((o) => (relevantLighterButBad(o) ? 1 : 0));
  return {
    taskId: first.taskId,
    coldFloor: first.coldFloor,
    landedRepeats: landed.length,
    repeats: n,
    relevantCompoundedFraction: landed.length === 0 ? null : mean(compoundedIndicators),
    lighterButBadFraction: landed.length === 0 ? null : mean(lighterButBadIndicators),
    decoyLightenedFraction: n === 0 ? 0 : repeats.filter(decoyLightened).length / n,
    seedLandedFraction: n === 0 ? 0 : landed.length / n,
    compoundedSpread: stdev(compoundedIndicators),
  };
}

/** Group a flat list of per-(task, repeat) outcomes into per-task buckets, preserving first-seen task order. */
function groupByTask(outcomes: readonly MoatOutcome[]): MoatOutcome[][] {
  const order: string[] = [];
  const byId = new Map<string, MoatOutcome[]>();
  for (const o of outcomes) {
    let bucket = byId.get(o.taskId);
    if (bucket === undefined) {
      bucket = [];
      byId.set(o.taskId, bucket);
      order.push(o.taskId);
    }
    bucket.push(o);
  }
  return order.map((id) => byId.get(id)!);
}

/**
 * Build the SCORED artifact from the flat per-(task, repeat) outcomes (the probe calls this only AFTER both gates
 * pass). The published rates aggregate over REPEATS, not tasks — so k>1 reports a stable rate, not a single draw:
 *   - `compoundRate`  = relevant repeats that LANDED, routed lighter, AND produced a GOOD result (the RESULTS-GATED
 *                       win — a lighter route alone is not enough) / relevant repeats that LANDED. The INDETERMINATE
 *                       non-landed repeats are excluded from BOTH numerator and denominator (recall never fired ⇒ no
 *                       signal); 0 when no relevant repeat landed.
 *   - `lighterButBadRate` = relevant repeats that LANDED and routed lighter but produced a BAD result / LANDED — the
 *                       honest "memory lightened it, the code failed" signal, never folded into the compound win.
 *   - `decoyLightenRate` = ALL decoy repeats that routed lighter / ALL decoy repeats — the false-positive base rate
 *                       (no landing filter: an irrelevant fact lightening IS the control signal).
 *   - `seedLandingRate`  = relevant repeats that landed / ALL relevant repeats — the validity readout.
 *   - `discrimination`   = compoundRate − decoyLightenRate.
 * The per-task census carries each task's fractions + a spread so the headline is never a bare point.
 */
export function buildScoredArtifact(outcomes: readonly MoatOutcome[], runs = 1): MoatArtifact {
  const total = outcomes.length;
  const landed = outcomes.filter((o) => o.relevant.landed);
  const compoundRate = landed.length === 0 ? 0 : landed.filter(relevantCompounded).length / landed.length;
  const lighterButBadRate = landed.length === 0 ? 0 : landed.filter(relevantLighterButBad).length / landed.length;
  const decoyLightenRate = total === 0 ? 0 : outcomes.filter(decoyLightened).length / total;
  const seedLandingRate = total === 0 ? 0 : landed.length / total;

  return {
    condition: "scored",
    compoundRate,
    lighterButBadRate,
    decoyLightenRate,
    discrimination: compoundRate - decoyLightenRate,
    seedLandingRate,
    seedLanding: { landedCount: landed.length, total },
    runs,
    census: groupByTask(outcomes).map(taskCensus),
    earlySignalCaveat: MOAT_CAVEAT,
  };
}

/** Build the ABORTED artifact: a gate fired, so NO compound number is produced — only the firing verdict. */
export function buildAbortedArtifact(abortVerdict: string): MoatArtifact {
  return { condition: "aborted", abortVerdict, compoundRate: null, earlySignalCaveat: MOAT_CAVEAT };
}

/** Serialize the artifact to pretty JSON at `path`. Returns the path written. */
export function writeArtifact(path: string, artifact: MoatArtifact): string {
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return path;
}
