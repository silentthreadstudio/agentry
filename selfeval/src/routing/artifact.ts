// The routing-accuracy artifact (AC3 / AC4 / AC9a / AC9b / AC10) — the shape the probe emits and the render
// to disk. This module owns ONLY the result data structure + serialization; the probe (`probe.ts`) owns the
// gated control flow that DECIDES whether an accuracy number is even produced. Two artifact conditions exist:
//   - an ABORTED run (a control gate fired): the artifact carries the firing control's verdict and NO accuracy
//     number / matrix — `accuracy` is `null` and `condition`/`passFail` are absent. This is the AC8 contract
//     made observable: a reader can see the abort and see that no score was emitted.
//   - a SCORED run (all gates passed): accuracy, the confusion matrix, over/under-route readouts, the
//     early-signal caveat, and — when a threshold X is provided — the success condition + computed pass/fail.
//
// AC10 is structural here: the ONLY input to `accuracy`/the matrix is the per-task DISPATCHED shape from
// `extractShape` over the captured stream (passed in as `RoutingOutcome.dispatched`). There is no
// task-completion / grade signal anywhere in selfeval to leak in — the artifact cannot compute a number from
// a proxy because no proxy exists in this package.

import { writeFileSync } from "node:fs";

import type { Shape } from "./shape.ts";
import { SHAPES_BY_WEIGHT } from "./shape.ts";

/** The early-signal caveat (AC4): N=6–8 is a DIRECTIONAL read, not a statistically powered estimate. PINNED. */
export const EARLY_SIGNAL_CAVEAT =
  "Early-signal (N=6–8): a directional read of where the rubric over- vs under-routes (~1–2 cases per cell), " +
  "NOT a statistically powered estimate — do not over-read the spread.";

/**
 * One per-task outcome the artifact scores over: the task's labeled floor and the shape the conductor actually
 * DISPATCHED (extracted from the captured stream — AC10's only shape input). A task whose run was degenerate
 * (no dispatch, did not settle cleanly — `DegenerateRunError`) carries `dispatched: null` and is counted as an
 * indeterminate miss, never silently dropped.
 */
export interface RoutingOutcome {
  taskId: string;
  /** Whether this task is a must-escalate trap (AC9b's zero-trap-underroute clause reads this). */
  mustEscalate: boolean;
  labeledFloor: Shape;
  /** The dispatched shape from `extractShape`, or `null` for an indeterminate/degenerate run. */
  dispatched: Shape | null;
}

/** A single confusion-matrix cell: labeled-floor × dispatched-shape and how many tasks landed in it. */
export interface ConfusionCell {
  labeledFloor: Shape;
  dispatched: Shape;
  count: number;
}

/** A task that over-routed (dispatched a HEAVIER shape than its floor) — the rubric over-orchestrated. */
export interface RouteDeviation {
  taskId: string;
  labeledFloor: Shape;
  dispatched: Shape;
}

/** The success condition (AC9a) — fixed FORM, threshold X set by the first run (AC9b). */
export interface SuccessCondition {
  /** The human-readable falsifiable condition: `accuracy ≥ X AND zero-trap-underroute`. */
  statement: string;
  /** The accuracy threshold X, or `null` when unset by design (OQ5) — then `xUnsetMarker` is present. */
  threshold: number | null;
  /** Present iff `threshold` is null: the explicit "X unset — set by first run" marker (AC9b). */
  xUnsetMarker?: string;
}

/** Pass/fail against the success condition's two clauses — only computed once X is provided (AC9b). */
export interface PassFail {
  pass: boolean;
  accuracyPass: boolean;
  zeroTrapUnderroute: boolean;
}

/**
 * The emitted artifact. `condition` describes the eval's terminal state:
 *   - `"aborted"` — a control gate fired; `abortVerdict` carries the pinned verdict; `accuracy` is `null` and
 *     the matrix / over/under-route readouts / pass-fail are ABSENT (AC8: no number when a gate fires).
 *   - `"scored"` — all gates passed; `accuracy`, `confusionMatrix`, `overRoutes`, `underRoutes` are populated.
 */
export interface RoutingArtifact {
  condition: "aborted" | "scored";
  /** The pinned verdict string of the control that aborted the run (only on `condition === "aborted"`). */
  abortVerdict?: string;
  /** `correct / total` as a number (AC3); `null` on an aborted run (no score is emitted — AC8). */
  accuracy: number | null;
  /** Labeled-floor × dispatched-shape cells (AC4); absent on an aborted run. */
  confusionMatrix?: ConfusionCell[];
  /** Tasks dispatched HEAVIER than their floor — over-orchestration (AC4); absent on an aborted run. */
  overRoutes?: RouteDeviation[];
  /** Tasks dispatched LIGHTER than their floor — under-orchestration (AC4); absent on an aborted run. */
  underRoutes?: RouteDeviation[];
  /** The directional / early-signal caveat (AC4) — always present so no reader over-reads the spread. */
  earlySignalCaveat: string;
  /** The pre-registered success condition (AC9a); absent on an aborted run. */
  successCondition?: SuccessCondition;
  /** Pass/fail against the condition (AC9b) — present only on a scored run WITH a threshold X. */
  passFail?: PassFail;
}

/** Index of a shape in the weight order — used to read over- vs under-route direction. */
function weightIndex(shape: Shape): number {
  return SHAPES_BY_WEIGHT.indexOf(shape);
}

/**
 * Build the SCORED artifact from the per-task outcomes (the probe calls this only AFTER every control gate has
 * passed). `accuracy = correct / total` (AC3): a task is correct iff its dispatched shape equals its labeled
 * floor; a degenerate (`dispatched: null`) task is an indeterminate miss (counted in `total`, never correct).
 * The confusion matrix is the labeled-floor × dispatched-shape census (AC4); over-routes (dispatched heavier)
 * and under-routes (dispatched lighter) are read off the weight order so each direction is separately readable.
 *
 * When `threshold` (X) is provided, the success condition is evaluated (AC9b): accuracy ≥ X AND no
 * must-escalate trap was under-routed (never one-shotted / dispatched below its floor). When X is unset (OQ5),
 * the condition still ships with the explicit "X unset" marker and NO pass/fail (AC9a form only).
 */
export function buildScoredArtifact(
  outcomes: readonly RoutingOutcome[],
  threshold: number | null,
): RoutingArtifact {
  const total = outcomes.length;
  const correct = outcomes.filter((o) => o.dispatched !== null && o.dispatched === o.labeledFloor).length;
  const accuracy = total === 0 ? 0 : correct / total;

  const overRoutes: RouteDeviation[] = [];
  const underRoutes: RouteDeviation[] = [];
  for (const o of outcomes) {
    if (o.dispatched === null) continue; // indeterminate run — not a direction, just a miss
    const delta = weightIndex(o.dispatched) - weightIndex(o.labeledFloor);
    if (delta > 0) {
      overRoutes.push({ taskId: o.taskId, labeledFloor: o.labeledFloor, dispatched: o.dispatched });
    } else if (delta < 0) {
      underRoutes.push({ taskId: o.taskId, labeledFloor: o.labeledFloor, dispatched: o.dispatched });
    }
  }

  // A trap is under-routed iff it is a must-escalate task dispatched BELOW its floor (one-shotted / too light).
  const trapUnderrouted = outcomes.some(
    (o) => o.mustEscalate && o.dispatched !== null && weightIndex(o.dispatched) < weightIndex(o.labeledFloor),
  );
  // A degenerate trap (no dispatch) also fails the zero-trap-underroute clause — it was never escalated.
  const trapIndeterminate = outcomes.some((o) => o.mustEscalate && o.dispatched === null);
  const zeroTrapUnderroute = !trapUnderrouted && !trapIndeterminate;

  const successCondition = buildCondition(threshold);
  const artifact: RoutingArtifact = {
    condition: "scored",
    accuracy,
    confusionMatrix: confusionMatrix(outcomes),
    overRoutes,
    underRoutes,
    earlySignalCaveat: EARLY_SIGNAL_CAVEAT,
    successCondition,
  };
  if (threshold !== null) {
    const accuracyPass = accuracy >= threshold;
    artifact.passFail = {
      pass: accuracyPass && zeroTrapUnderroute,
      accuracyPass,
      zeroTrapUnderroute,
    };
  }
  return artifact;
}

/**
 * Build the ABORTED artifact (AC8): a control gate fired, so NO accuracy number / matrix / pass-fail is
 * produced — only the firing control's pinned verdict and the always-on caveat. The absence of `accuracy`
 * (it is `null`) is the observable proof that scoring did not run.
 */
export function buildAbortedArtifact(abortVerdict: string): RoutingArtifact {
  return {
    condition: "aborted",
    abortVerdict,
    accuracy: null,
    earlySignalCaveat: EARLY_SIGNAL_CAVEAT,
  };
}

/** The labeled-floor × dispatched-shape census (AC4): one cell per (floor, dispatched) pair with a hit. */
function confusionMatrix(outcomes: readonly RoutingOutcome[]): ConfusionCell[] {
  const counts = new Map<string, ConfusionCell>();
  for (const o of outcomes) {
    if (o.dispatched === null) continue; // a degenerate run has no dispatched shape to place in the matrix
    const key = `${o.labeledFloor}=>${o.dispatched}`;
    const cell = counts.get(key);
    if (cell) {
      cell.count++;
    } else {
      counts.set(key, { labeledFloor: o.labeledFloor, dispatched: o.dispatched, count: 1 });
    }
  }
  return [...counts.values()];
}

/** The AC9a success condition — fixed form; threshold X null ⇒ ship the "X unset — set by first run" marker. */
function buildCondition(threshold: number | null): SuccessCondition {
  const xLabel = threshold === null ? "X" : String(threshold);
  const condition: SuccessCondition = {
    statement: `accuracy ≥ ${xLabel} AND zero-trap-underroute (no must-escalate trap dispatched below its floor)`,
    threshold,
  };
  if (threshold === null) {
    condition.xUnsetMarker = "X unset — set by first run (OQ5)";
  }
  return condition;
}

/** Serialize the artifact to pretty JSON at `path`. Returns the path written (the command echoes it to stdout). */
export function writeArtifact(path: string, artifact: RoutingArtifact): string {
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return path;
}
