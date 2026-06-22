// The PURE results-gated scorer (ADR-001) — the correctness HEART of the rightsizing bench. It combines the routed
// `Shape` (read from the settled work folder by T-03's extract) with the JUDGED result quality (from the shared
// judge engine, T-01) and emits the three published rates — `right-sizing-success` / `over-route-tax` /
// `under-route-failure` — PLUS the `indeterminate` terminal category. ZERO I/O so it is fully unit-testable on
// synthetic records (mirrors the purity of the old `routing/artifact.ts` + `outcome/score.ts`). The probe (T-03)
// owns the gated control flow that DECIDES whether a score is even produced and collects the records this consumes;
// this module owns ONLY the data structures + the bucketing math.
//
// The reframe this scorer exists to make honest (memory `routing-eval-is-results-gated`): a lighter-than-label
// route that produced a GOOD result is a WIN, not a miss. `correctFloor` is a REFERENCE, not ground truth — the
// only real routing miss is a route LIGHTER than the floor that produced a BAD result (under-route-failure). A
// heavier-than-floor route that still produced a good result is wasted process (over-route-tax). NEVER a bare
// label-match accuracy field (the `routing/artifact.ts:218` bug being fixed).
//
// The `indeterminate` category (ADR-001 §S3 — the load-bearing requirement): a task needs BOTH signals present —
// the routed `shape` AND the judged `result` — to be scored. When EITHER is absent (extract threw
// `DegenerateRunError`, or the build hit the timeout ceiling before settling so no produced tree exists to judge)
// the task is `indeterminate`: its OWN terminal category, EXCLUDED from the three rates' denominator, counted +
// surfaced separately, and NEVER folded into `under-route-failure` (folding a harness/cost failure into the
// router's miss rate would re-corrupt the exact signal this scorer makes honest).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Shape } from "../conduct/shape.ts";
import { SHAPES_BY_WEIGHT } from "../conduct/shape.ts";
import type { Score } from "../judge/index.ts";
import type { Trap } from "./fixture.ts";

/**
 * The judged-quality bar a result must clear to count as GOOD (ADR-001 §the published rates). Pinned explicitly
 * (like `OVERCLAIM_QUALITY_THRESHOLD` was) so the win/miss split is reproducible, not a vibe: a result whose judged
 * overall is `>=` this is GOOD; strictly below is BAD. `0.5` = at least half the rubric's max — a deliverable the
 * judge rates below half-quality is not a credible success. The judged overall is the signal; the optional oracle
 * floor is only an auxiliary tie-breaker (never the sole signal — ADR-001).
 */
export const RESULT_GOOD_THRESHOLD = 0.5;

/**
 * The four terminal outcomes of one scored task (ADR-001 §the published rates + §indeterminate):
 *   - `right-sizing-success` — routed at-or-LIGHTER than the floor AND the result is GOOD (lighter+good is a WIN);
 *   - `over-route-tax`       — result GOOD but routed HEAVIER than the floor (wasted process);
 *   - `under-route-failure`  — result BAD and routed LIGHTER than the floor (the ONLY real routing miss);
 *   - `indeterminate`        — no judgeable settled result (a signal was absent) — its OWN terminal category.
 */
export type TaskOutcome =
  | "right-sizing-success"
  | "over-route-tax"
  | "under-route-failure"
  | "indeterminate";

/**
 * One collected per-run record — the scorer's atomic unit. The probe (T-03) builds records matching this exact
 * shape from one conduct-once run. BOTH `shape` and `result` are OPTIONAL: an ABSENT signal is the indeterminate
 * trigger, so the scorer never throws on a missing field (a degenerate run yields a record with no `shape`; a
 * timed-out build yields a record with no `result`).
 *   - `shape` is the routed `Shape` read from the settled work folder (T-03's `extractShape`); ABSENT when extract
 *     threw `DegenerateRunError` (a no-artifact run that did not settle cleanly).
 *   - `result` is the JUDGED `Score` (T-01) — the four anchored dimensions + the `sum/max` overall; ABSENT when the
 *     build hit the timeout ceiling before settling so no produced tree exists to judge.
 *   - `correctFloor` is the fixture's defended floor REFERENCE (T-04) — never ground truth, only the comparison point.
 *   - `trap` is the fixture's optional trap label; a `must-escalate` trap that one-shots-and-succeeds is a WIN, and
 *     one that one-shots-and-fails is the cleanest under-route-failure (both fall out of the standard bucketing —
 *     the trap is carried for the per-task census readout, never to special-case the math).
 *   - `cost` is the settled run's process cost (optional, surfaced as-is — never divided into an efficiency ratio).
 */
export interface RightsizingRunRecord {
  /** The fixture id (the task identity in the census). */
  fixtureId: string;
  /** The fixture's defended floor — a REFERENCE for at/lighter/heavier, never ground truth. */
  correctFloor: Shape;
  /** The routed shape read from the settled work folder; ABSENT ⇒ degenerate ⇒ indeterminate. */
  shape?: Shape;
  /** The JUDGED result quality (the only quality signal); ABSENT ⇒ no judgeable result ⇒ indeterminate. */
  result?: Score;
  /** Did the agent self-report DONE? Paired with `result` for the overclaim signal (said done, judged quality too low). */
  selfReportedDone?: boolean;
  /** The fixture's optional trap label, carried for the census (the bucketing needs no special case for it). */
  trap?: Trap;
  /** The settled run's raw process cost (optional; surfaced as-is — never an efficiency ratio). */
  cost?: RightsizingCost;
}

/** A run's raw process cost — every field optional (a partial envelope contributes only what it has). Surfaced as-is. */
export interface RightsizingCost {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalCostUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

/** One per-task census row — the readable trace of how each task was bucketed (route vs reference, result, outcome). */
export interface RightsizingCensusRow {
  fixtureId: string;
  correctFloor: Shape;
  /** The routed shape, or `null` when absent (a degenerate run). */
  shape: Shape | null;
  /** The judged overall (0..1), or `null` when no result was judged (a timed-out build). */
  resultOverall: number | null;
  /** Whether the judged result cleared {@link RESULT_GOOD_THRESHOLD}; `null` when no result was judged. */
  resultGood: boolean | null;
  /** The fixture's trap label, when it carried one. */
  trap?: Trap;
  /** The terminal outcome this task was bucketed into. */
  outcome: TaskOutcome;
}

/**
 * The four-rate confusion census the artifact publishes (NEVER a bare label-match accuracy). The three published
 * RATES are computed over the DETERMINATE denominator (tasks where both signals were present); `indeterminate` is
 * counted + surfaced SEPARATELY with its own rate over the FULL task count — never folded into the rates.
 */
export interface RightsizingRates {
  /** Tasks with both signals present — the denominator of the three published rates (excludes indeterminate). */
  determinate: number;
  /** Total tasks scored, including indeterminate — the denominator of `indeterminateRate`. */
  total: number;
  /** Routed at-or-lighter than the floor AND result GOOD, over `determinate` (the headline; 0 when none). */
  rightSizingSuccessRate: number;
  /** Result GOOD but routed HEAVIER than the floor, over `determinate` (0 when none). */
  overRouteTaxRate: number;
  /** Result BAD and routed LIGHTER than the floor, over `determinate` — the only real routing miss (0 when none). */
  underRouteFailureRate: number;
  /** No judgeable settled result, over `total` — its OWN rate, surfaced (never folded into under-route-failure). */
  indeterminateRate: number;
  /** Raw counts behind every rate (the auditable denominators). */
  counts: {
    rightSizingSuccess: number;
    overRouteTax: number;
    underRouteFailure: number;
    indeterminate: number;
  };
  /** Must-escalate traps that were under-routed (one-shotted and FAILED) — the success condition requires this be 0. */
  underRoutedTraps: number;
}

/**
 * The pre-registered right-sizing-success target `X` (ADR-001 §thresholds) — the FALSIFIABLE FORM, written before
 * any run in the tracked `thresholds.json`. `value` is the calibration number (`null` until the owner sets it from
 * the first run — NEVER invented in advance); `calibrationPending` flags that pending state explicitly. This is a
 * TARGET, not a claimed result: the artifact always reports the honest measured rates regardless of `X` (memory
 * `routing-eval-is-results-gated` — the rates are the signal, the target never inflates them).
 *
 * Mirrors `moat`'s `MoatThreshold`: the registered OBJECT is always present (never a bare null on the public path —
 * AC-THRESH); only the calibration NUMBER (`value`) is null while pending.
 */
export interface RightsizingThreshold {
  /** The human-readable falsifiable condition (`right-sizing-success ≥ X AND zero-under-route-failure-on-traps`). */
  statement: string;
  /** Which measured quantity X gates — `rightSizingSuccessRate`. */
  metric: string;
  /** The success-rate target number, or `null` when uncalibrated (set by the first run; never fabricated here). */
  value: number | null;
  /** Explicitly true while `value` is unset — so a reader never mistakes "not yet calibrated" for "no target". */
  calibrationPending: boolean;
}

/**
 * The pre-registered success condition carried ON THE PUBLIC ARTIFACT PATH (AC-THRESH). Mirrors the moat probe's
 * `MoatSuccessCondition`: never a bare null — the registered target FORM ({@link RightsizingThreshold}) is always
 * present. `pass` is computed only once `X` is calibrated (`value` non-null) AND a run was scored (not aborted) —
 * AND it folds in the trap requirement (`zero-under-route-failure-on-traps`): the condition passes only when the
 * success rate clears `X` AND no must-escalate trap was under-routed.
 */
export interface RightsizingSuccessCondition {
  /** The pre-registered target — always non-null (the form ships before any run). */
  target: RightsizingThreshold;
  /** The measured right-sizing-success rate this run produced, or `null` on an aborted run (a gate fired ⇒ no number). */
  observed: number | null;
  /** True iff `target.value` is uncalibrated — mirrors `target.calibrationPending`, surfaced for consumers. */
  calibrationPending: boolean;
  /** Whether the run cleared `X` AND under-routed zero traps; present ONLY when a `value` is set AND a run was scored. */
  pass?: boolean;
}

/**
 * The emitted artifact. `condition`:
 *   - `"aborted"` — a control gate fired upstream; `abortVerdict` carries the pinned verdict and NO numbers are
 *     produced (`rates`/`census` are ABSENT; `successCondition.observed` is `null` and `pass` is absent) — the
 *     observable proof scoring did not run.
 *   - `"scored"` — gates passed; the four-rate census (`rates`), the per-task `census`, and the pre-registered
 *     `successCondition` (with the run's observed success rate + pass/fail when calibrated) are populated. NEVER a
 *     bare label-match accuracy field.
 */
export interface RightsizingArtifact {
  condition: "scored" | "aborted";
  /** The pinned verdict of the gate that aborted the run (only on `condition === "aborted"`). */
  abortVerdict?: string;
  /** The four published rates + the indeterminate tally; ABSENT on an aborted run (no number when a gate fires). */
  rates?: RightsizingRates;
  /** The per-task census (the readable trace); ABSENT on an aborted run. */
  census?: readonly RightsizingCensusRow[];
  /** The pre-registered success condition — ALWAYS present (the falsifiable form ships even on an aborted run). */
  successCondition: RightsizingSuccessCondition;
}

/** Options for {@link buildScoredArtifact}: override the thresholds source (tests point at a fixture file). */
export interface RightsizingScoreOptions {
  /** Override the pre-registered `thresholds.json` location (the tracked package root by default). */
  thresholdPath?: string;
}

/** The path to the tracked, pre-registered `thresholds.json` at the package root (resolved relative to `src/rightsizing/`). */
const THRESHOLDS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "thresholds.json");

/**
 * Load the pre-registered right-sizing target `X` from the tracked `thresholds.json` (the single source — disjoint
 * top-level keys keep it parallel-safe with `moat`/`W`). Returns the registered {@link RightsizingThreshold}
 * verbatim; THROWS if the file or the `rightsizing.X` key is missing, since the FALSIFIABLE TARGET MUST EXIST before
 * a run (AC-THRESH — the public path may never silently fall back to "no target").
 */
export function loadRightsizingThreshold(path: string = THRESHOLDS_PATH): RightsizingThreshold {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { rightsizing?: { X?: RightsizingThreshold } };
  const x = raw.rightsizing?.X;
  if (x === undefined || x === null) {
    throw new Error(`thresholds.json is missing the pre-registered rightsizing target (rightsizing.X) at ${path}`);
  }
  return x;
}

/** Index in the weight order (one-shot=0, spec-first=1, decompose=2) — the lighter/heavier comparison reads this. */
function weight(shape: Shape): number {
  return SHAPES_BY_WEIGHT.indexOf(shape);
}

/** A judged result is GOOD iff its overall clears {@link RESULT_GOOD_THRESHOLD} (>=, not strictly above). */
function isGood(result: Score): boolean {
  return result.overall >= RESULT_GOOD_THRESHOLD;
}

/**
 * Bucket ONE record into its terminal {@link TaskOutcome} (the heart of the scorer). The order matters:
 *   1. EITHER signal absent (no `shape` OR no `result`) ⇒ `indeterminate` — checked FIRST so a degenerate or
 *      timed-out run is NEVER mis-bucketed into a routing rate.
 *   2. routed HEAVIER than the floor ⇒ `over-route-tax` if the result is good (wasted process), else
 *      `under-route-failure` is NOT it (a heavier route that failed is not an UNDER-route — see below).
 *   3. routed at-or-LIGHTER than the floor: GOOD ⇒ `right-sizing-success` (lighter+good is the WIN); BAD ⇒
 *      `under-route-failure` (the only real routing miss).
 *
 * A heavier-than-floor route with a BAD result is still over-route-tax-shaped on the ROUTE axis but failed on the
 * RESULT axis; it is not an UNDER-route miss (the router did not skimp). We classify it as `over-route-tax` — the
 * route was wasteful; the failure is the build's, not an under-route. This keeps `under-route-failure` meaning
 * exactly "routed too light AND it cost the result", the signal ADR-001 protects.
 *
 * Traps need NO special case: a must-escalate trap one-shotted (routed lighter than its escalated floor) that
 * SUCCEEDS is at/lighter+good ⇒ right-sizing-success (a WIN); one that FAILS is lighter+bad ⇒ under-route-failure
 * (the cleanest miss). The trap label is carried only for the census, never to branch the math.
 */
function bucket(record: RightsizingRunRecord): TaskOutcome {
  if (record.shape === undefined || record.result === undefined) return "indeterminate";

  const good = isGood(record.result);
  const heavier = weight(record.shape) > weight(record.correctFloor);

  if (heavier) return "over-route-tax";
  // at-or-lighter than the floor:
  return good ? "right-sizing-success" : "under-route-failure";
}

/** Build the per-task census row for a record (the readable trace; the outcome drives the rate aggregation). */
function censusRow(record: RightsizingRunRecord): RightsizingCensusRow {
  const outcome = bucket(record);
  const row: RightsizingCensusRow = {
    fixtureId: record.fixtureId,
    correctFloor: record.correctFloor,
    shape: record.shape ?? null,
    resultOverall: record.result ? record.result.overall : null,
    resultGood: record.result ? isGood(record.result) : null,
    outcome,
  };
  if (record.trap !== undefined) row.trap = record.trap;
  return row;
}

/**
 * Aggregate the census rows into the four-rate {@link RightsizingRates}. The three published rates use the
 * DETERMINATE denominator (rows whose outcome is not `indeterminate`); `indeterminate` is counted + surfaced over
 * the FULL total — never folded into `under-route-failure`. `underRoutedTraps` counts must-escalate traps that
 * landed in `under-route-failure` (the success-condition requires this be 0).
 */
function aggregate(rows: readonly RightsizingCensusRow[]): RightsizingRates {
  const total = rows.length;
  const rightSizingSuccess = rows.filter((r) => r.outcome === "right-sizing-success").length;
  const overRouteTax = rows.filter((r) => r.outcome === "over-route-tax").length;
  const underRouteFailure = rows.filter((r) => r.outcome === "under-route-failure").length;
  const indeterminate = rows.filter((r) => r.outcome === "indeterminate").length;
  const determinate = total - indeterminate;

  const underRoutedTraps = rows.filter(
    (r) => r.trap === "must-escalate" && r.outcome === "under-route-failure",
  ).length;

  const rate = (count: number): number => (determinate === 0 ? 0 : count / determinate);

  return {
    determinate,
    total,
    rightSizingSuccessRate: rate(rightSizingSuccess),
    overRouteTaxRate: rate(overRouteTax),
    underRouteFailureRate: rate(underRouteFailure),
    indeterminateRate: total === 0 ? 0 : indeterminate / total,
    counts: { rightSizingSuccess, overRouteTax, underRouteFailure, indeterminate },
    underRoutedTraps,
  };
}

/**
 * Build the pre-registered success condition from the registered target and the scored rates. The target is ALWAYS
 * present (never a bare null — AC-THRESH). `pass` is computed only when `X` is calibrated (`value` non-null) AND a
 * run was scored (`rates` present); it requires BOTH halves of the condition: the success rate clears `X` AND no
 * must-escalate trap was under-routed. On an aborted run (no `rates`) `pass` is absent — the honest "no pass/fail
 * without a number" stance the moat condition also takes.
 */
function buildSuccessCondition(
  target: RightsizingThreshold,
  rates: RightsizingRates | null,
): RightsizingSuccessCondition {
  const condition: RightsizingSuccessCondition = {
    target,
    observed: rates === null ? null : rates.rightSizingSuccessRate,
    calibrationPending: target.calibrationPending,
  };
  if (target.value !== null && rates !== null) {
    condition.pass = rates.rightSizingSuccessRate >= target.value && rates.underRoutedTraps === 0;
  }
  return condition;
}

/**
 * Build the SCORED artifact from the flat per-run records (the probe calls this only AFTER every control gate has
 * passed). Each record is bucketed into its terminal outcome; the three published rates are computed over the
 * determinate denominator, and `indeterminate` is counted + surfaced separately. The pre-registered `X` is read
 * from `thresholds.json` and attached as the falsifiable `successCondition`. Pure aside from the one threshold
 * read: reads its arguments, allocates, returns — no spawn, never throws on an absent optional field.
 */
export function buildScoredArtifact(
  records: readonly RightsizingRunRecord[],
  opts: RightsizingScoreOptions = {},
): RightsizingArtifact {
  const target = loadRightsizingThreshold(opts.thresholdPath);
  const census = records.map(censusRow);
  const rates = aggregate(census);

  return {
    condition: "scored",
    rates,
    census,
    successCondition: buildSuccessCondition(target, rates),
  };
}

/**
 * Build the ABORTED artifact (mirrors the moat/outcome aborted/scored discriminator): a control gate fired
 * upstream, so NO score is produced — only the firing control's pinned verdict and the still-on-record falsifiable
 * target (with `observed: null`, `pass` absent). The absence of `rates`/`census` is the observable proof scoring
 * did not run. The pre-registered `X` is still read + surfaced so the falsifiable form ships even on an abort.
 */
export function buildAbortedArtifact(
  abortVerdict: string,
  opts: RightsizingScoreOptions = {},
): RightsizingArtifact {
  const target = loadRightsizingThreshold(opts.thresholdPath);
  return {
    condition: "aborted",
    abortVerdict,
    successCondition: buildSuccessCondition(target, null),
  };
}

/**
 * The pre-registered right-sizing-success target `X` (AC-THRESH) exposed for downstream consumers (the probe / the
 * report). It is the registered {@link RightsizingThreshold} OBJECT — always present, never a bare null on the
 * public path; only its calibration `value` is null while `calibrationPending` (the FORM ships now, the NUMBER is
 * set by the first run — ADR-001 §thresholds, never fabricated here). Read live from the tracked `thresholds.json`.
 */
export const RIGHTSIZING_SUCCESS_THRESHOLD: RightsizingThreshold = loadRightsizingThreshold();
