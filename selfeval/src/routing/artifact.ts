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

/**
 * The multi-run outcome for one task (the variance unit). When the probe runs each task `runs` times it
 * collects `runs` dispatched shapes here (a degenerate repeat ⇒ `null` for that index); the single-run case
 * (`runs === 1`) carries exactly one shape, so `shapes` collapses to `[dispatched]` and the variance readouts
 * degenerate to the point estimate. The per-run accuracy distribution reads the SHAPE AT EACH RUN INDEX across
 * tasks, so `shapes` is index-aligned: `shapes[i]` is task's shape on run `i` for every task.
 */
export interface TaskRuns {
  taskId: string;
  mustEscalate: boolean;
  labeledFloor: Shape;
  /** The dispatched shape per run (length `runs`); a degenerate repeat is `null`. */
  shapes: readonly (Shape | null)[];
}

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
 * One row of the per-task stability table (multi-run variance). For a task run `runs` times:
 *   - `modalShape` is the most frequent dispatched shape across the runs (ties broken by process-weight order,
 *     lightest first — a deterministic, documented tie-break; `null` only when EVERY run was degenerate);
 *   - `stability` is the fraction of runs whose shape equals `modalShape` (1.0 = routed identically every time;
 *     < 1.0 = the router is noisy on this task). Degenerate runs count against stability (mode is over shapes,
 *     not over null);
 *   - `correctFraction` is the fraction of runs whose shape equals the labeled floor — the noise-aware per-task
 *     hit rate that feeds the expected-accuracy point estimate.
 */
export interface TaskStability {
  taskId: string;
  labeledFloor: Shape;
  /** The most frequent shape across the runs, or `null` if every run was degenerate. */
  modalShape: Shape | null;
  /** Fraction of runs equal to `modalShape` (0 when every run was degenerate). */
  stability: number;
  /** Fraction of runs equal to the labeled floor. */
  correctFraction: number;
}

/**
 * The overall accuracy with error bars across the `runs` repeats (additive, multi-run only). Two complementary
 * views (see the Spec): the per-run accuracy DISTRIBUTION (`mean`/`std`/`min`/`max` of the k single-run
 * accuracies) shows run-to-run spread; `expected` (mean over tasks of `correctFraction`) is the noise-aware
 * point estimate. `runs` records how many repeats produced the distribution.
 */
export interface AccuracyDistribution {
  /** Number of repeats each task was run (k). */
  runs: number;
  /** The per-run accuracies, one per run index — `accuracy_i = (#tasks whose run-i shape == label) / N`. */
  perRunAccuracy: readonly number[];
  /** Mean of `perRunAccuracy`. */
  accuracyMean: number;
  /** Population standard deviation of `perRunAccuracy` (0 when every run scored identically). */
  accuracyStd: number;
  /** Min of `perRunAccuracy`. */
  accuracyMin: number;
  /** Max of `perRunAccuracy`. */
  accuracyMax: number;
  /** The noise-aware point estimate: mean over tasks of `correctFraction`. */
  expectedAccuracy: number;
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
  /**
   * MULTI-RUN VARIANCE (additive). Present only on a scored run with `runs > 1`; ABSENT when `runs === 1` so
   * the single-run artifact is byte-for-byte today's shape. `accuracyDistribution` is the run-to-run accuracy
   * spread (error bars) + the noise-aware expected accuracy; `stabilityTable` is the per-task variance census;
   * `noisyTasks` is the ids whose `stability < 1.0` (a router that routed inconsistently on that task).
   */
  accuracyDistribution?: AccuracyDistribution;
  stabilityTable?: TaskStability[];
  noisyTasks?: string[];
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
  taskRuns?: readonly TaskRuns[],
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

  // Multi-run variance is ADDITIVE: only attached when the probe ran each task more than once. With a single
  // run, the fields stay absent so the artifact is identical to today's shape (Spec backward-compat clause).
  if (taskRuns !== undefined && taskRuns.length > 0 && (taskRuns[0]!.shapes.length) > 1) {
    const stabilityTable = taskRuns.map(taskStability);
    artifact.stabilityTable = stabilityTable;
    artifact.noisyTasks = stabilityTable.filter((t) => t.stability < 1).map((t) => t.taskId);
    artifact.accuracyDistribution = accuracyDistribution(taskRuns, stabilityTable);
  }

  return artifact;
}

/**
 * Per-task variance row (multi-run). The mode is taken over the NON-degenerate shapes only (a degenerate run
 * is never "the most common shape"); ties are broken by process-weight order (lightest first) so the readout
 * is deterministic and reproducible. `stability` and `correctFraction` divide by the FULL run count (degenerate
 * runs count against both — a run that didn't route cleanly is neither stable nor correct).
 */
function taskStability(t: TaskRuns): TaskStability {
  const runs = t.shapes.length;
  const counts = new Map<Shape, number>();
  for (const s of t.shapes) {
    if (s === null) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }

  let modalShape: Shape | null = null;
  let modalCount = 0;
  // Iterate in weight order so a tie resolves to the lighter shape deterministically.
  for (const shape of SHAPES_BY_WEIGHT) {
    const c = counts.get(shape) ?? 0;
    if (c > modalCount) {
      modalCount = c;
      modalShape = shape;
    }
  }

  const stability = runs === 0 ? 0 : modalCount / runs;
  const correctHits = t.shapes.filter((s) => s !== null && s === t.labeledFloor).length;
  const correctFraction = runs === 0 ? 0 : correctHits / runs;
  return { taskId: t.taskId, labeledFloor: t.labeledFloor, modalShape, stability, correctFraction };
}

/**
 * The overall accuracy distribution across the `runs` repeats. The per-run accuracy reads the shape at each run
 * INDEX across all tasks (`accuracy_i = #correct-at-run-i / N`), so it requires the per-task `shapes` arrays to
 * be index-aligned (they are: every task is run the same `runs` times in the same order). `expectedAccuracy` is
 * the mean over tasks of `correctFraction` — the noise-aware point estimate, independent of run alignment.
 */
function accuracyDistribution(
  taskRuns: readonly TaskRuns[],
  stabilityTable: readonly TaskStability[],
): AccuracyDistribution {
  const n = taskRuns.length;
  const runs = n === 0 ? 0 : taskRuns[0]!.shapes.length;

  const perRunAccuracy: number[] = [];
  for (let i = 0; i < runs; i++) {
    const correctAtI = taskRuns.filter((t) => {
      const s = t.shapes[i];
      return s !== null && s !== undefined && s === t.labeledFloor;
    }).length;
    perRunAccuracy.push(n === 0 ? 0 : correctAtI / n);
  }

  const accuracyMean = mean(perRunAccuracy);
  const accuracyStd = std(perRunAccuracy, accuracyMean);
  const expectedAccuracy = mean(stabilityTable.map((t) => t.correctFraction));
  return {
    runs,
    perRunAccuracy,
    accuracyMean,
    accuracyStd,
    accuracyMin: perRunAccuracy.length === 0 ? 0 : Math.min(...perRunAccuracy),
    accuracyMax: perRunAccuracy.length === 0 ? 0 : Math.max(...perRunAccuracy),
    expectedAccuracy,
  };
}

/** Arithmetic mean (0 for an empty set). */
function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population standard deviation about `m` (0 for an empty set, and 0 when every value equals the mean). */
function std(xs: readonly number[], m: number): number {
  if (xs.length === 0) return 0;
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
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
