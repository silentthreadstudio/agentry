// Assemble the SOURCE-OF-TRUTH scoreboard JSON (M7/T-009, ADR-002 Fork B) — raw cells + grader results +
// pre-computed stats → the PINNED `Scoreboard` shape from T-004's types.ts. This module RENDERS the numbers
// T-008 already computed; it never does statistics itself (the `stats/**` seam is disjoint — see the task's
// `excludes`). It also never writes to disk (the CLI/orchestrator T-010 owns that).
//
// The output `Scoreboard` shape is PINNED in types.ts and must be produced verbatim — this module never adds
// a field to that contract (the accepted AC9 seam: reproducibility compares the JSON via T-008's
// `reproducible()`, which derives its tolerance from the recorded `variance`). The INPUT shapes for `grades`
// and `stats` are this module's own consumed contract (not pinned cross-package types), so they are declared
// here, expressed in terms of the upstream T-006 (GradeResult) and T-008 (PairedDelta / Aggregate) types.
//
// AC4 honesty (load-bearing): a per-cell aggregate's variance is `undefined` at N<2 (T-008
// `Aggregate.variance`). This module never coerces that to 0 — the per-regime table reports only `mean`s
// (the pinned `RegimeRow` has no per-arm variance slot), and a cell that is absent stays absent rather than a
// fabricated zero. The pinned `ClaimVerdict.variance` is a `number` (the delta's measured spread, derived
// from the bootstrap half-width); it is the spread T-008's `reproducible()` reads back as `sqrt(variance)`.

import type {
  Arm,
  ClaimVerdict,
  R3PairResult,
  Regime,
  RegimeRow,
  Scoreboard,
} from "../types.ts";
import type { Aggregate } from "../stats/aggregate.ts";
import type { PairedDelta } from "../stats/bootstrap.ts";
import { verdict, type VerdictConfig } from "../stats/verdict.ts";

/**
 * One C1–C4 claim's pre-computed statistics: the paired delta (from T-008's `pairedDelta`) the verdict is
 * decided on. The scoreboard turns this into a pinned `ClaimVerdict` via T-008's `verdict()` gate.
 */
export interface ClaimStat {
  /** The paired-delta result T-008 computed for this claim's metric (delta + CI + half-width + effect size). */
  delta: PairedDelta;
}

/** The C1–C4 claim statistics, keyed exactly as the pinned `Scoreboard.claims` shape. */
export interface ClaimStats {
  c1: ClaimStat;
  c2: ClaimStat;
  c3: ClaimStat;
  c4: ClaimStat;
}

/** One arm's pre-computed per-cell metrics within a regime — the numbers T-008 aggregated for that cell. */
export interface ArmRegimeStat {
  /** Mean AC-pass rate in [0,1] over the cell's N runs. */
  acPassRate: Aggregate;
  /** R3 also reports tokens/turns per arm (AC3); omit for non-R3 regimes. */
  tokens?: Aggregate;
  turns?: Aggregate;
}

/** Per-regime, per-arm aggregated stats — one entry per (regime × arm) cell present in the run. */
export type RegimeStats = {
  [R in Regime]?: Partial<Record<Arm, ArmRegimeStat>>;
};

/**
 * One R3 teacher→follow-up pair's pre-computed moat statistics. `cold`/`warm` are the per-arm summary metrics
 * for the SAME follow-up (AC7); `moat` is the paired C−B delta T-008 computed on that follow-up.
 */
export interface R3PairStat {
  followUpTaskId: string;
  /** Cold-arm (B) summary metric for the follow-up. */
  cold: PairedDelta;
  /** Warm-arm (C) summary metric for the follow-up. */
  warm: PairedDelta;
  /** The paired warm−cold (C−B) delta on the follow-up — the moat. */
  moat: PairedDelta;
  /** Whether the declared reused lesson was observed (AC8) — from T-006's `lessonReuse`. */
  lessonReused: boolean;
  lessonReuseEvidence?: string;
}

/** The pre-computed statistics the scoreboard projects — all produced by the disjoint T-008 stats seam. */
export interface ScoreboardStats {
  /** The C1–C4 claim statistics + the min-effect-size gate config T-008's `verdict()` consumes. */
  claims: ClaimStats;
  verdictConfig: VerdictConfig;
  /** Per-regime, per-arm aggregated metrics (AC3). */
  regimes: RegimeStats;
  /** The R3 moat pairs (AC7) — empty when the suite has no R3 pairs. */
  r3: R3PairStat[];
}

/** One cell's grader result, keyed to its (regime × arm) — the R2 met/total coverage source (AC15). */
export interface CellGrade {
  regime: Regime;
  arm: Arm;
  /** Checks met / total over the cell — T-006's `GradeResult.passed` / `.total`, kept as a count (AC15). */
  passed: number;
  total: number;
}

/** The regime order the per-regime table is emitted in (deterministic, suite-spanning). */
const REGIME_ORDER: readonly Regime[] = ["R0", "R1", "R1prime", "R2", "R3"];
/** The arm order metrics are listed in within a regime row (deterministic). */
const ARM_ORDER: readonly Arm[] = ["A", "B", "C"];

/**
 * Project one claim's paired-delta stats into a pinned `ClaimVerdict`. The verdict is T-008's gate
 * (`verdict()` — CI excludes 0 AND |effect| ≥ min); `delta` is the measured point delta; `variance` is the
 * delta's spread, derived from the bootstrap CI half-width (`variance = halfWidth²`) so that T-008's
 * `reproducible()` — which reads `sqrt(variance)` as its tolerance — recovers exactly that half-width band.
 */
function toClaimVerdict(stat: ClaimStat, config: VerdictConfig): ClaimVerdict {
  return {
    verdict: verdict(stat.delta, config),
    delta: stat.delta.delta,
    variance: stat.delta.ciHalfWidth * stat.delta.ciHalfWidth,
  };
}

/**
 * Build one per-regime table row (AC3): the mean AC-pass rate per arm present in the regime, plus tokens/turns
 * per arm for R3. AC4 honesty: an aggregate's `mean` is reported as-is; a cell with no entry is simply absent
 * (the row only lists arms actually present), never a fabricated zero.
 */
function toRegimeRow(regime: Regime, arms: Partial<Record<Arm, ArmRegimeStat>>): RegimeRow {
  const acPassRateByArm: Partial<Record<Arm, number>> = {};
  const tokensByArm: Partial<Record<Arm, number>> = {};
  const turnsByArm: Partial<Record<Arm, number>> = {};
  let hasTokens = false;
  let hasTurns = false;

  for (const arm of ARM_ORDER) {
    const cell = arms[arm];
    if (cell === undefined) continue;
    acPassRateByArm[arm] = cell.acPassRate.mean;
    if (cell.tokens !== undefined) {
      tokensByArm[arm] = cell.tokens.mean;
      hasTokens = true;
    }
    if (cell.turns !== undefined) {
      turnsByArm[arm] = cell.turns.mean;
      hasTurns = true;
    }
  }

  const row: RegimeRow = { regime, acPassRateByArm };
  if (hasTokens) row.tokensByArm = tokensByArm;
  if (hasTurns) row.turnsByArm = turnsByArm;
  return row;
}

/** Project one R3 pair's stats into the pinned `R3PairResult` (AC7): B/C summaries + the computed C−B moat. */
function toR3PairResult(stat: R3PairStat, config: VerdictConfig): R3PairResult {
  const result: R3PairResult = {
    followUpTaskId: stat.followUpTaskId,
    cold: toClaimVerdict({ delta: stat.cold }, config),
    warm: toClaimVerdict({ delta: stat.warm }, config),
    moatDelta: stat.moat.delta,
    lessonReused: stat.lessonReused,
  };
  if (stat.lessonReuseEvidence !== undefined) result.lessonReuseEvidence = stat.lessonReuseEvidence;
  return result;
}

/**
 * Assemble the source-of-truth `Scoreboard` (the PINNED T-004 shape). Combines the raw grader coverage
 * (`grades`, for the R2 met/total — AC15) with the pre-computed T-008 statistics (`stats`) into:
 *   • `claims`     — C1–C4, each {verdict, delta, variance} (AC2);
 *   • `perRegime`  — every regime present, with per-arm metrics, in deterministic regime order (AC3);
 *   • `r3`         — each teacher→follow-up pair's B/C + C−B moat + lesson-reuse signal (AC7/AC8).
 *
 * `grades` carries the R2 set-coverage (`passed`/`total`) verbatim from T-006 so AC15 stays a count, not a
 * boolean — surfaced as `r2Coverage`, a scoreboard-local addendum (the pinned `Scoreboard` has no count slot;
 * this EXTENDS the artifact without modifying T-004's type — see `ScoreboardArtifact`). The honest-null verdict
 * (T-008 returning `'null'`) flows through untouched (AC13). This function is pure and does no I/O — the
 * orchestrator (T-010) writes the returned object to `scoreboard.json`.
 */
export function assembleScoreboard(
  grades: CellGrade[],
  stats: ScoreboardStats,
): ScoreboardArtifact {
  const claims = {
    c1: toClaimVerdict(stats.claims.c1, stats.verdictConfig),
    c2: toClaimVerdict(stats.claims.c2, stats.verdictConfig),
    c3: toClaimVerdict(stats.claims.c3, stats.verdictConfig),
    c4: toClaimVerdict(stats.claims.c4, stats.verdictConfig),
  };

  const perRegime: RegimeRow[] = [];
  for (const regime of REGIME_ORDER) {
    const arms = stats.regimes[regime];
    if (arms === undefined) continue;
    perRegime.push(toRegimeRow(regime, arms));
  }

  const r3 = stats.r3.map((pair) => toR3PairResult(pair, stats.verdictConfig));

  return { claims, perRegime, r3, ...attachCoverage(grades) };
}

/**
 * R2 set-coverage per arm (AC15) — `met / total`, kept as a count, never collapsed to a boolean. Surfaced as a
 * non-pinned addendum on the assembled object so the Markdown projection can render it without widening the
 * pinned `Scoreboard` contract. Multiple R2 cells for the same arm are summed (met and total both accumulate).
 */
function attachCoverage(grades: CellGrade[]): { r2Coverage: R2Coverage } {
  const byArm: Partial<Record<Arm, { met: number; total: number }>> = {};
  for (const grade of grades) {
    if (grade.regime !== "R2") continue;
    const acc = byArm[grade.arm] ?? { met: 0, total: 0 };
    acc.met += grade.passed;
    acc.total += grade.total;
    byArm[grade.arm] = acc;
  }
  return { r2Coverage: byArm };
}

/** R2 met/total coverage per arm (AC15) — the count behind C3, never a boolean. */
export type R2Coverage = Partial<Record<Arm, { met: number; total: number }>>;

/**
 * The assembled scoreboard artifact: the PINNED `Scoreboard` (the AC9 reproducibility target, unchanged) plus
 * the `r2Coverage` count addendum (AC15). This EXTENDS the pinned shape rather than modifying T-004's type —
 * `reproducible()` still consumes it as a `Scoreboard` (a `ScoreboardArtifact` IS a `Scoreboard`).
 */
export type ScoreboardArtifact = Scoreboard & { r2Coverage: R2Coverage };
