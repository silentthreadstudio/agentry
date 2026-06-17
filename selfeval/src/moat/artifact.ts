// The moat (memory-hygiene) artifact — the shape the probe emits and renders to disk. Like the routing artifact,
// it has two terminal conditions: ABORTED (a control gate fired — no compound score, only the verdict) and SCORED
// (gates passed — the compound rate, the decoy contrast, and the per-task census). This module owns ONLY the data
// structure + scoring math; `probe.ts` owns the gated control flow that decides whether a number is produced.
//
// The single measured quantity: did a prior decision in memory make a task route LIGHTER than its cold floor?
// "Lighter" is read off the shared shape-weight order (one-shot < spec-first < decompose), so this dimension
// reuses the routing vocabulary rather than inventing its own.

import { writeFileSync } from "node:fs";

import type { Shape } from "../routing/shape.ts";
import { SHAPES_BY_WEIGHT } from "../routing/shape.ts";

/** One warm run's result: the dispatched shape (null = degenerate/indeterminate) and whether recall landed the seed. */
export interface WarmRun {
  shape: Shape | null;
  landed: boolean;
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

/** Per-task census row in the scored artifact — the readable trace of each task's compounding behavior. */
export interface MoatCensusRow {
  taskId: string;
  coldFloor: Shape;
  warmRelevant: Shape | null;
  warmDecoy: Shape | null;
  landedRelevant: boolean;
  landedDecoy: boolean;
  /** Relevant memory recalled AND routed lighter than the cold floor. */
  compounded: boolean;
  /** The decoy did NOT lighten the shape (the control held). */
  decoyHeld: boolean;
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
  /** Fraction of tasks where the recalled relevant decision routed the task lighter than its cold floor; `null` on abort. */
  compoundRate: number | null;
  /** Fraction of tasks where the irrelevant DECOY also lightened the shape (should be ~0); absent on abort. */
  decoyLightenRate?: number;
  /** `compoundRate − decoyLightenRate` — the memory-attributable lightening (the clean signal); absent on abort. */
  discrimination?: number;
  /** How many warm-relevant runs recalled their seed (the validity readout); absent on abort. */
  seedLanding?: { landedCount: number; total: number };
  /** Per-task census; absent on abort. */
  census?: MoatCensusRow[];
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

/** Build the per-task census row from an outcome (the compounding/decoy-held booleans the scorer also aggregates). */
export function censusRow(o: MoatOutcome): MoatCensusRow {
  const compounded = o.relevant.landed && lighterThanFloor(o.relevant, o.coldFloor);
  const decoyHeld = !lighterThanFloor(o.decoy, o.coldFloor);
  return {
    taskId: o.taskId,
    coldFloor: o.coldFloor,
    warmRelevant: o.relevant.shape,
    warmDecoy: o.decoy.shape,
    landedRelevant: o.relevant.landed,
    landedDecoy: o.decoy.landed,
    compounded,
    decoyHeld,
  };
}

/**
 * Build the SCORED artifact (the probe calls this only AFTER both gates pass). `compoundRate` is the fraction of
 * tasks whose recalled relevant decision routed them lighter than the cold floor; `decoyLightenRate` is the
 * fraction where the irrelevant decoy ALSO lightened (the contrast — should be ~0); `discrimination` is the
 * memory-attributable difference. The per-task census is the readable trace.
 */
export function buildScoredArtifact(outcomes: readonly MoatOutcome[]): MoatArtifact {
  const rows = outcomes.map(censusRow);
  const n = rows.length;
  const compoundRate = n === 0 ? 0 : rows.filter((r) => r.compounded).length / n;
  const decoyLightenRate = n === 0 ? 0 : rows.filter((r) => !r.decoyHeld).length / n;
  const landedCount = outcomes.filter((o) => o.relevant.landed).length;

  return {
    condition: "scored",
    compoundRate,
    decoyLightenRate,
    discrimination: compoundRate - decoyLightenRate,
    seedLanding: { landedCount, total: n },
    census: rows,
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
