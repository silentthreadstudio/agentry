// The PINNED benchmark data contract — the shapes that flow M4(runner)→M5(grader)→M6(stats)→M7(scoreboard).
//
// These live HERE, not in @agentry/core, by deliberate decision (T-004 contract): they have exactly one
// consumer pipeline (the benchmark harness) and no second package reads them — putting them in core would
// be premature cross-package coupling (CLAUDE.md "types in core" is for SHARED contracts; YAGNI otherwise).
// Siblings (T-006 grader, T-008 stats, T-009 scoreboard, T-010 orchestrator) import these field names
// verbatim — do not rename a field without updating every consumer.

/**
 * A path within a run's produced working tree, relative to the sandbox working dir
 * (e.g. `"src/index.ts"`). The grader (M5) checks the hidden suite against these paths;
 * an empty tree (`[]`) is the by-construction 0%-pass case.
 */
export type TreePath = string;

/**
 * The cost axis of a single `claude -p` run. Field names are PINNED.
 *
 * Token fields are summed across ALL `modelUsage` model keys (the conductor + every subagent;
 * see R0b — `usage.*` is parent-only and undercounts the subagent tax ~18%). `totalCostUsd` is
 * the authoritative full-run cost (`total_cost_usd`, already cross-model). `numTurns` is `num_turns`.
 * `durationMs` is the run's own wall-clock (`duration_ms`, corroborated by the runner's timer).
 */
export interface Cost {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  numTurns: number;
  totalCostUsd: number;
  durationMs: number;
}

/**
 * The full record of ONE run through the Runner port — the unit the grader/stats/scoreboard consume.
 * `raw` is the unparsed `claude -p` result envelope, kept for audit/debug (never relied on for shape).
 */
export interface RunRecord {
  cost: Cost;
  /** Files the agent produced in the sandbox working tree (relative paths); `[]` = empty solution. */
  producedTree: TreePath[];
  /** Memory record ids/keys the run reported using — the M5 lesson-reuse signal (AC8). */
  usedMemories: string[];
  /** The raw `claude -p` result envelope, retained for audit. */
  raw: unknown;
}

/** The three experiment arms: A = plain (no Agentry), B = cold (Agentry, empty roots), C = warm (seeded). */
export type Arm = "A" | "B" | "C";

/** The four task regimes the suite spans (R1′ = the bug-seeded R1 variant). */
export type Regime = "R0" | "R1" | "R1prime" | "R2" | "R3";

/**
 * The N runs of one (regime × arm) cell — produced by the orchestrator (M2/T-010), consumed by stats (M6).
 * Stats computes mean + variance over `runs` (variance is undefined at N=1, never silently averaged — AC4).
 */
export interface CellResult {
  regime: Regime;
  arm: Arm;
  runs: RunRecord[];
}

/** A C1–C4 win-condition verdict. `null` = no measurable win inside variance (the honest-null bar, AC13). */
export type Verdict = "win" | "null" | "loss";

/**
 * One C1–C4 claim's outcome: the verdict plus the measured paired delta and its variance/spread over N.
 * AC2 requires {verdict, delta, variance} present for each of C1, C2, C3, C4.
 */
export interface ClaimVerdict {
  verdict: Verdict;
  /** Measured paired delta (e.g. C−B) for the claim; sign/metric is the claim's own (set by M6). */
  delta: number;
  /** Variance/spread of the delta over the N repeats (the significance context for the verdict). */
  variance: number;
}

/** One row of the per-regime breakdown table (AC3): the metric(s) each regime is graded on. */
export interface RegimeRow {
  regime: Regime;
  /** Mean AC-pass-rate per arm present in this regime (arm → rate in [0,1]). */
  acPassRateByArm: Partial<Record<Arm, number>>;
  /** R3 also reports tokens/turns per arm (AC3); absent for non-R3 regimes. */
  tokensByArm?: Partial<Record<Arm, number>>;
  turnsByArm?: Partial<Record<Arm, number>>;
}

/** One R3 teacher→follow-up pair's moat result: B vs C on the SAME follow-up task (AC7), plus reuse signal (AC8). */
export interface R3PairResult {
  /** The follow-up task id both arms ran (AC7: delta computed on the same follow-up). */
  followUpTaskId: string;
  /** Cold-arm (B) cell summary metric for the follow-up. */
  cold: ClaimVerdict;
  /** Warm-arm (C) cell summary metric for the follow-up. */
  warm: ClaimVerdict;
  /** Computed warm−cold moat delta on the follow-up. */
  moatDelta: number;
  /** Whether the declared reused lesson was observed (AC8) — yes/no with optional evidence. */
  lessonReused: boolean;
  lessonReuseEvidence?: string;
}

/**
 * The TRUTH artifact (M7/T-009 assembles it → `scoreboard.json`; AC9 re-reads it to check reproducibility).
 * Shape PINNED here. A flat Markdown render is a projection of this, never the source of truth.
 */
export interface Scoreboard {
  /** The C1–C4 win-condition verdicts, each {verdict, delta, variance} (AC2). */
  claims: {
    c1: ClaimVerdict;
    c2: ClaimVerdict;
    c3: ClaimVerdict;
    c4: ClaimVerdict;
  };
  /** Per-regime breakdown table (AC3) — every regime present in the suite, with its graded metric(s). */
  perRegime: RegimeRow[];
  /** The R3 moat section: each teacher→follow-up pair's B/C result + delta + lesson-reuse signal (AC7, AC8). */
  r3: R3PairResult[];
}
