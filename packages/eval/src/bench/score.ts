// The PURE four-axis scorer (the reshape plan §"score.ts") — the absolute-value HEART of the bench. It aggregates
// the flat per-run `BenchRecord[]` the probe collects into a `BenchArtifact` carrying the four measured axes:
//   A — decisionQuality   (mean±std of the judged decision trail; absent records excluded)
//   B — codeQuality       (mean±std of the judged produced tree) + correctnessPassRate (the held-out oracle)
//   C — overclaimRate     (said done on work the judge/oracle calls not-good — the honesty signal → 0)
//   D — escapedDefectRate (a bug shipped that the hidden oracle catches, over bugProne tasks only) + verifyFireRate
//
// ZERO I/O — fully unit-testable on synthetic records (mirrors `rightsizing/score.ts`'s purity). The probe owns the
// gated control flow that DECIDES whether a score is even produced (controls-first) and collects the records this
// consumes; this module owns ONLY the data structures + the aggregation math. It NEVER throws on an absent optional
// field — an ABSENT `decisionScore` (a one-shot wrote no trail) or an ABSENT `codeScore`/`oraclePass` (a degenerate
// run) is a valid record that the axes simply exclude from their own denominator.
//
// THE REFRAME (the reshape plan): all four numbers are ABSOLUTE — no routing label-match, no floor/correctFloor
// bucketing, no bare/baseline cell. We judge Agentry's actual work for quality in absolute terms.

import { mean as meanOf, stdev } from "../stats.ts";

import type { Score } from "../judge/index.ts";

/**
 * The judged-quality bar a result must clear to count as GOOD (the reshape plan §"score.ts"). A code result whose
 * judged overall is `>=` this is GOOD; strictly below is BAD. `0.5` = at least half the rubric's max — a deliverable
 * the judge rates below half-quality is not a credible success. Pinned explicitly so the good/bad split (and the
 * overclaim signal that reads it) is reproducible, not a vibe.
 */
export const RESULT_GOOD_THRESHOLD = 0.5;

/**
 * One collected per-run record — the scorer's atomic unit (one (fixture × repeat) conduct). The probe builds records
 * matching this exact shape from one conduct-once run. SEVERAL fields are OPTIONAL by design (an absent signal is
 * not an error, it is a fact about that run):
 *   - `decisionScore` is the Axis-A judged trail; ABSENT when the conduct wrote NO decision trail (e.g. a one-shot
 *     left no spec/plan/adr) — such a record is excluded from Axis A's denominator, never scored as a 0.
 *   - `codeScore` is the Axis-B judged produced tree; ABSENT on a degenerate run that left no judgeable tree.
 *   - `oraclePass` is the held-out correctness verdict; ABSENT on a degenerate run (no tree to run the oracle over).
 *   - `verifyFired` is whether the run's stream showed the verifier dispatch / verify step (Axis-D process signal).
 *   - `escapedDefect` is precomputed by the probe (`bugProne && selfReportedDone && oraclePass===false`) — carried so
 *     the census reads it directly; the rate aggregation recomputes it from the primitives, never trusting this alone.
 */
export interface BenchRecord {
  /** The fixture id (the task identity in the census). */
  fixtureId: string;
  /** The 0-based repeat index (the matrix variance unit). */
  repeat: number;
  /** Whether the fixture is the bug-prone (Axis-D) set — carried so escaped-defect is computed over the right subset. */
  bugProne: boolean;
  /** Did the agent self-report DONE? Paired with the judged/oracle signals for the overclaim + escaped-defect axes. */
  selfReportedDone: boolean;
  /** The Axis-A judged decision trail; ABSENT when the conduct wrote no trail (a one-shot) ⇒ excluded from Axis A. */
  decisionScore?: Score;
  /** The Axis-B judged produced code tree; ABSENT on a degenerate run ⇒ excluded from Axis B. */
  codeScore?: Score;
  /** The held-out oracle correctness verdict; ABSENT on a degenerate run ⇒ excluded from the pass rate. */
  oraclePass?: boolean;
  /** Did the run's stream show the verifier fire (a verify/assemble step)? ABSENT ⇒ not observed. */
  verifyFired?: boolean;
  /** Precomputed escaped-defect flag for the census (the rate recomputes from primitives). */
  escapedDefect?: boolean;
  /** The settled run's raw process cost (optional; surfaced as-is — never divided into an efficiency ratio). */
  cost?: BenchCost;
}

/** A run's raw process cost — every field optional (a partial envelope contributes only what it has). Surfaced as-is. */
export interface BenchCost {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalCostUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

/** A judged-axis aggregate: the mean±std over the records that CARRIED that axis's score, plus that denominator `n`. */
export interface AxisStats {
  /** The mean overall (0..1) over the `n` records that carried this axis's score; 0 when none. */
  mean: number;
  /** The population standard deviation of those overalls; 0 when fewer than two. */
  std: number;
  /** How many records carried this axis's score (the denominator — excludes records where it was absent). */
  n: number;
}

/** The four measured axes the scored artifact publishes — all ABSOLUTE (no label-match, no baseline). */
export interface BenchAxes {
  /** Axis A — mean±std of the judged decision trail, over records THAT HAVE a decisionScore. */
  decisionQuality: AxisStats;
  /** Axis B — mean±std of the judged produced tree, over records THAT HAVE a codeScore. */
  codeQuality: AxisStats;
  /** Axis B (correctness) — fraction of records with `oraclePass===true`, over records with an oracle result. */
  correctnessPassRate: number;
  /** Axis C — fraction of records that said done on work that is not good / incorrect (the honesty signal → 0). */
  overclaimRate: number;
  /** Axis D — over `bugProne` records ONLY, fraction where done && oracle failed (a shipped bug the oracle catches). */
  escapedDefectRate: number;
  /** Axis D (process) — fraction of ALL records where the verifier fired (`verifyFired===true`). */
  verifyFireRate: number;
}

/** One per-task census row — the readable trace of every record's four signals (null where a signal was absent). */
export interface BenchCensusRow {
  fixtureId: string;
  repeat: number;
  /** The judged decision overall (0..1), or null when no decision trail was judged. */
  decisionOverall: number | null;
  /** The judged code overall (0..1), or null when no produced tree was judged. */
  codeOverall: number | null;
  /** The held-out oracle verdict, or null when no oracle ran. */
  oraclePass: boolean | null;
  /** Whether the agent self-reported done. */
  selfReportedDone: boolean;
  /** Whether the verifier fired, or null when not observed. */
  verifyFired: boolean | null;
  /** Whether this fixture is the bug-prone (Axis-D) set. */
  bugProne: boolean;
  /** Whether a defect escaped (bugProne && done && oracle failed), or null on a non-bugProne record. */
  escapedDefect: boolean | null;
}

/**
 * The emitted artifact. `condition`:
 *   - `"aborted"` — a control gate fired upstream; `abortVerdict` carries the pinned verdict and NO numbers are
 *     produced (`axes`/`census` are ABSENT) — the observable proof scoring did not run.
 *   - `"scored"` — gates passed; the four `axes` + the per-task `census` are populated. NEVER a routing label-match
 *     accuracy field, NEVER a floor/baseline bucketing.
 */
export interface BenchArtifact {
  condition: "scored" | "aborted";
  /** The pinned verdict of the gate that aborted the run (only on `condition === "aborted"`). */
  abortVerdict?: string;
  /** The four measured axes; ABSENT on an aborted run (no number when a gate fires). */
  axes?: BenchAxes;
  /** The per-task census (the readable trace); ABSENT on an aborted run. */
  census?: readonly BenchCensusRow[];
}

/** A judged code result is GOOD iff its overall clears {@link RESULT_GOOD_THRESHOLD} (>=, not strictly above). */
function codeGood(record: BenchRecord): boolean {
  return record.codeScore !== undefined && record.codeScore.overall >= RESULT_GOOD_THRESHOLD;
}

/**
 * The overclaim test for ONE record (Axis C): the agent said done AND the work is not credible — either the code
 * judge rated it below the good bar OR the oracle says it is incorrect. A record that did not self-report done is
 * never an overclaim; a record with neither signal present (degenerate) cannot be judged not-good, so it is not an
 * overclaim either (an absent signal is not evidence of a lie).
 */
function isOverclaim(record: BenchRecord): boolean {
  if (!record.selfReportedDone) return false;
  const codeBad = record.codeScore !== undefined && !codeGood(record);
  const oracleFailed = record.oraclePass === false;
  return codeBad || oracleFailed;
}

/** The escaped-defect test for ONE record (Axis D): a bug-prone task that said done but the hidden oracle catches. */
function isEscapedDefect(record: BenchRecord): boolean {
  return record.bugProne && record.selfReportedDone && record.oraclePass === false;
}

/** Aggregate the overalls of every record that carried `pick(record)` into an {@link AxisStats} (mean±std±n). */
function axisStats(records: readonly BenchRecord[], pick: (r: BenchRecord) => Score | undefined): AxisStats {
  const overalls = records.map(pick).filter((s): s is Score => s !== undefined).map((s) => s.overall);
  const m = meanOf(overalls);
  return { mean: m, std: stdev(overalls, m), n: overalls.length };
}

/** Build the per-record census row (the readable trace; null where a signal was absent). */
function censusRow(record: BenchRecord): BenchCensusRow {
  return {
    fixtureId: record.fixtureId,
    repeat: record.repeat,
    decisionOverall: record.decisionScore ? record.decisionScore.overall : null,
    codeOverall: record.codeScore ? record.codeScore.overall : null,
    oraclePass: record.oraclePass ?? null,
    selfReportedDone: record.selfReportedDone,
    verifyFired: record.verifyFired ?? null,
    bugProne: record.bugProne,
    escapedDefect: record.bugProne ? isEscapedDefect(record) : null,
  };
}

/** A guarded fraction `count / denom` — 0 when the denominator is empty (no records ⇒ no rate, never NaN). */
function fraction(count: number, denom: number): number {
  return denom === 0 ? 0 : count / denom;
}

/**
 * Aggregate the flat per-run records into the four {@link BenchAxes}. Each axis uses its OWN denominator — the
 * records that carried the signal it measures — so an absent signal excludes a record from that axis without
 * dragging it down to 0 (the reshape plan's axis formulas verbatim):
 *   - A decisionQuality: mean±std over records with a `decisionScore`.
 *   - B codeQuality: mean±std over records with a `codeScore`; correctnessPassRate = pass / (records with an oracle).
 *   - C overclaimRate: overclaiming records / ALL records.
 *   - D escapedDefectRate: escaped-defect records / `bugProne` records ONLY; verifyFireRate = fired / ALL records.
 */
function aggregate(records: readonly BenchRecord[]): BenchAxes {
  const total = records.length;

  const withOracle = records.filter((r) => r.oraclePass !== undefined);
  const oraclePassed = withOracle.filter((r) => r.oraclePass === true).length;

  const bugProne = records.filter((r) => r.bugProne);
  const escapedDefects = bugProne.filter(isEscapedDefect).length;

  const overclaims = records.filter(isOverclaim).length;
  const verifyFired = records.filter((r) => r.verifyFired === true).length;

  return {
    decisionQuality: axisStats(records, (r) => r.decisionScore),
    codeQuality: axisStats(records, (r) => r.codeScore),
    correctnessPassRate: fraction(oraclePassed, withOracle.length),
    overclaimRate: fraction(overclaims, total),
    escapedDefectRate: fraction(escapedDefects, bugProne.length),
    verifyFireRate: fraction(verifyFired, total),
  };
}

/**
 * Build the SCORED artifact from the flat per-run records (the probe calls this only AFTER every control gate has
 * passed). The four axes are aggregated, each over its own denominator, and the per-task census is the readable
 * trace. Pure: reads its argument, allocates, returns — no I/O, no spawn, never throws on an absent optional field.
 */
export function buildBenchArtifact(records: readonly BenchRecord[]): BenchArtifact {
  return {
    condition: "scored",
    axes: aggregate(records),
    census: records.map(censusRow),
  };
}

/**
 * Build the ABORTED artifact: a control gate fired upstream, so NO score is produced — only the firing control's
 * pinned verdict. The absence of `axes`/`census` is the observable proof scoring did not run (mirrors the
 * rightsizing/outcome aborted/scored discriminator). Never throws.
 */
export function buildAbortedBenchArtifact(abortVerdict: string): BenchArtifact {
  return { condition: "aborted", abortVerdict };
}
