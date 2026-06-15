// The ORCHESTRATOR (Plan §2.1 M8 / T-010) — the integration finisher. It IMPORTS and SEQUENCES every layer;
// it owns no layer's internal logic. The flow it drives, per (regime × arm) cell, per run:
//
//   prepareSandbox(arm)            (M2/T-005) — fresh working dir + two fresh, relocated memory roots
//   withholdGrader(fixture, sb)    (M2/T-005) — copy the task tree in, NEVER the hidden grader/ (AC10)
//   restoreWarmSnapshot(sb)        (M3/T-007) — ARM C ONLY: fill the roots from the teacher snapshot
//   Runner.run(invocation, sb)     (M4/T-004) — the one hexagonal seam; live OR replay, injected by the caller
//   assertEmptyRoots(sb)           (M2/T-005) — ARMS A/B: after a confirmed run, prove the roots stayed empty
//   grade(sb.workingDir, suite)    (M5/T-006) — deterministic AC-pass over the produced tree
//
// then, across the collected matrix: aggregate / pairedDelta / verdict (M6/T-008) → assembleScoreboard
// (M7/T-009) → write the `ScoreboardArtifact` to disk (this module owns the I/O).
//
// AC12 ENFORCEMENT IS PER RUN, HERE: the R0 finding (findings/R0-isolation.md) is explicit — `assertEmptyRoots`
// is only meaningful AFTER a confirmed-successful run (else "empty because isolated" is indistinguishable from
// "empty because nothing ran"). So we call it AFTER `Runner.run` returns, for arms A/B. Arm C is snapshot-
// restored BEFORE the run (its roots are deliberately non-empty), so it is exempt from the emptiness assert.
//
// SCOREBOARD TYPING (verifier note, T-009): the artifact is written/read as `ScoreboardArtifact` (the pinned
// `Scoreboard` PLUS the AC15 `r2Coverage` count) — NOT the narrower `Scoreboard`, which would silently drop
// the R2 met/total coverage from the on-disk JSON that AC9 re-reads.
//
// CLAIM → METRIC WIRING (doc 06 §4): the C1–C4 paired deltas are mechanical projections of the matrix —
//   C1 (R0)      : B − A AC-pass-rate (no tax: Agentry ≥ plain)
//   C2 (R1prime) : B − A AC-pass-rate (fewer escaped defects)
//   C3 (R2)      : B − A AC-pass-rate (fewer missed requirements)
//   C4 (R3 moat) : C − B AC-pass-rate on the same follow-up (the moat — warm beats cold)
// A claim whose cells are absent from the run degrades to a defined zero-delta honest-null, never a crash.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Arm, CellResult, Regime, RunRecord, TreePath } from "./types.ts";
import type { Runner, Invocation } from "./runner/port.ts";
import type { BenchmarkConfig } from "./config.ts";

import { prepareSandbox } from "./arms/sandbox.ts";
import { assertEmptyRoots, withholdGrader } from "./arms/isolation.ts";
import { armPluginDir, discoverRepoRoot } from "./arms/arms.ts";
import { restoreWarmSnapshot } from "./arms/seed.ts";
import { loadSuite, type SuiteTask } from "./suite/loader.ts";
import { grade } from "./grader/runner.ts";
import { loadGraderFixture } from "./grader/fixture.ts";
import { aggregate } from "./stats/aggregate.ts";
import { pairedDelta, type BootstrapConfig } from "./stats/bootstrap.ts";
import type { VerdictConfig } from "./stats/verdict.ts";
import {
  assembleScoreboard,
  type CellGrade,
  type ClaimStat,
  type ScoreboardArtifact,
  type ScoreboardStats,
  type ArmRegimeStat,
  type RegimeStats,
} from "./scoreboard/assemble.ts";
import { renderMarkdown } from "./scoreboard/render.ts";

/** The model pinned across every arm (the confound rule, Spec §4) — discovered from env, never hard-coded. */
export const MODEL_ENV = "AGENTRY_BENCH_MODEL";
/** Fallback model id when `AGENTRY_BENCH_MODEL` is unset. */
export const DEFAULT_MODEL = "claude-opus-4-8[1m]";

/** Bootstrap + verdict knobs the stats layer consumes — config-driven (Spec §6.1 OQ3 is calibratable). */
export interface StatsConfig {
  bootstrap: BootstrapConfig;
  verdict: VerdictConfig;
}

/** Default stats config — derives the bootstrap seed from the run seed so AC9 reproducibility is stable. */
export function defaultStatsConfig(seed: number): StatsConfig {
  return {
    bootstrap: { resamples: 2000, ciLevel: 0.95, seed },
    verdict: { minEffectSize: 0.8 },
  };
}

/** Side-channel for surfacing the planned spend / progress without coupling the orchestrator to stdout. */
export interface OrchestratorLogger {
  (message: string): void;
}

/** What `runBenchmark` produces: the assembled artifact + where it was written. */
export interface BenchmarkRunResult {
  scoreboard: ScoreboardArtifact;
  /** Absolute/CWD-relative path the JSON artifact was written to. */
  jsonPath: string;
  /** Path the Markdown projection was written to, when requested. */
  markdownPath?: string;
  /** The planned `claude -p` call count this run announced (N × cells). */
  plannedCalls: number;
}

/** Options for a full benchmark run — the Runner is INJECTED (replay in tests, live from the CLI). */
export interface RunBenchmarkOptions {
  config: BenchmarkConfig;
  /** The Runner port impl — `replayRunner`/`replaySequenceRunner` (tests) or `liveRunner` (CLI). */
  runner: Runner;
  /** Where to write `scoreboard.json`. */
  jsonPath: string;
  /** Optional path for the Markdown projection (`scoreboard.md`); omitted ⇒ JSON only. */
  markdownPath?: string;
  /** Stats knobs; defaults derived from `config.seed`. */
  stats?: StatsConfig;
  /** Progress/announcement sink; defaults to a no-op (the CLI passes a stdout logger). */
  log?: OrchestratorLogger;
}

/**
 * One (regime × arm) cell of the matrix. `task` is the suite task whose grader the cell is scored against
 * (for R3, the cell runs the FOLLOW-UP task — the moat is measured on it). `sandboxes` are the per-run sandboxes
 * (kept so per-run grading reads the produced tree the run wrote into; one per run).
 */
interface MatrixCell {
  regime: Regime;
  arm: Arm;
  task: SuiteTask;
  result: CellResult;
  /** The produced-tree root per run (sandbox.workingDir), in run order — the grader scores against these. */
  producedRoots: TreePath[];
}

/**
 * Run the whole benchmark: build the matrix, drive each cell's runs through the layer pipeline, then assemble
 * and persist the scoreboard. Makes API calls ONLY through the injected `runner` — a replay runner spends zero.
 */
export async function runBenchmark(options: RunBenchmarkOptions): Promise<BenchmarkRunResult> {
  const { config, runner, jsonPath } = options;
  const log: OrchestratorLogger = options.log ?? (() => {});
  const stats = options.stats ?? defaultStatsConfig(config.seed);

  const suite = loadSuite(config.suitePath);
  const plan = buildMatrixPlan(suite, config);

  const plannedCalls = plan.length * config.n;
  log(
    `Planned ${plannedCalls} run(s): ${plan.length} cell(s) × N=${config.n} ` +
      `(arms ${config.arms.join(",")}, seed ${config.seed}). Each run is one \`claude -p\` call under the live Runner.`,
  );

  const cells: MatrixCell[] = [];
  for (const planned of plan) {
    const cell = await runCell(planned, config, runner);
    cells.push(cell);
  }

  const scoreboard = assemble(cells, stats);
  const written = writeArtifacts(scoreboard, jsonPath, options.markdownPath);

  log(`Wrote scoreboard to ${written.jsonPath}${written.markdownPath ? ` and ${written.markdownPath}` : ""}.`);

  return { scoreboard, ...written, plannedCalls };
}

/** One planned cell of the matrix before it runs: which regime × arm, scored against which suite task. */
interface PlannedCell {
  regime: Regime;
  arm: Arm;
  task: SuiteTask;
}

/**
 * Build the deterministic (regime × arm) plan from the loaded suite + config. Order is governed by the seed
 * only through `orderTasks` (task ordering/sampling — AC9); regimes/arms keep their canonical order so the
 * matrix is reproducible. For R3, the cell is scored against the FOLLOW-UP task (the one carrying `lesson`),
 * since the moat (C4) is measured on the follow-up both arms run.
 */
function buildMatrixPlan(suite: SuiteTask[], config: BenchmarkConfig): PlannedCell[] {
  if (config.cells !== undefined) {
    return config.cells.map(({ regime, arm }) => ({
      regime,
      arm,
      task: pickScoredTask(suite, regime),
    }));
  }

  const ordered = orderTasks(suite, config.seed);
  const plan: PlannedCell[] = [];
  for (const task of ordered) {
    // R3 is scored on the follow-up only (it carries `lesson`); the teacher seeds memory but is not a C4 cell.
    if (task.manifest.regime === "R3" && task.manifest.lesson === undefined) continue;
    for (const arm of config.arms) {
      if (!task.manifest.armEligibility.includes(arm)) continue;
      plan.push({ regime: task.manifest.regime, arm, task });
    }
  }
  return plan;
}

/** Pick the suite task that scores a regime (R3 ⇒ the follow-up carrying `lesson`; else the regime's task). */
function pickScoredTask(suite: SuiteTask[], regime: Regime): SuiteTask {
  const candidates = suite.filter((t) => t.manifest.regime === regime);
  if (candidates.length === 0) {
    throw new Error(`orchestrator: no suite task for regime ${regime}`);
  }
  if (regime === "R3") {
    const followUp = candidates.find((t) => t.manifest.lesson !== undefined);
    if (followUp !== undefined) return followUp;
  }
  return candidates[0]!;
}

/**
 * Deterministically order the suite tasks by the seed (AC9: ordering/sampling is seed-controlled, NOT model
 * output). A seeded Fisher–Yates over a stable id-sorted base means the same config+seed always yields the same
 * order, while a different seed reshuffles — the only place the seed touches the run's structure.
 */
function orderTasks(suite: SuiteTask[], seed: number): SuiteTask[] {
  const base = [...suite].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  let a = (seed >>> 0) || 1;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = base.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [base[i], base[j]] = [base[j]!, base[i]!];
  }
  return base;
}

/**
 * Run one cell's N repeats through the full per-run pipeline and aggregate the produced tree per run. This is
 * where AC12 isolation is ENFORCED per run: arm C is snapshot-restored before the run; arms A/B are asserted
 * empty AFTER a confirmed run (the R0 sequencing rule).
 */
async function runCell(
  planned: PlannedCell,
  config: BenchmarkConfig,
  runner: Runner,
): Promise<MatrixCell> {
  const runs: RunRecord[] = [];
  const producedRoots: TreePath[] = [];
  const invocation = buildInvocation(planned);

  for (let i = 0; i < config.n; i++) {
    const sandbox = prepareSandbox(planned.arm);
    // Mount the task inputs WITHOUT the hidden grader/ (AC10) — the agent never sees the answer key on disk.
    withholdGrader(planned.task.fixtureDir, sandbox);

    // ARM C (warm): fill the roots from the teacher snapshot BEFORE the run (its roots are deliberately seeded).
    if (planned.arm === "C") restoreWarmSnapshot(sandbox);

    const record = await runner.run(invocation, sandbox);

    // ARMS A/B (plain/cold): the roots must have stayed empty — assert AFTER a confirmed run (R0 sequencing).
    if (planned.arm === "A" || planned.arm === "B") assertEmptyRoots(sandbox);

    runs.push(record);
    producedRoots.push(sandbox.workingDir);
  }

  return {
    regime: planned.regime,
    arm: planned.arm,
    task: planned.task,
    result: { regime: planned.regime, arm: planned.arm, runs },
    producedRoots,
  };
}

/** Build the model-pinned `Invocation` for a cell. Model is discovered from env; the arm sets the plugin dir. */
function buildInvocation(planned: PlannedCell): Invocation {
  const model = process.env[MODEL_ENV] || DEFAULT_MODEL;
  const prompt = planned.task.manifest.prompt ?? "";
  const invocation: Invocation = {
    prompt,
    model,
    permissionMode: "bypassPermissions",
  };
  const pluginDir = armPluginDir(planned.arm, discoverRepoRoot());
  if (pluginDir !== undefined) invocation.pluginDir = pluginDir;
  return invocation;
}

/** Grade every run of a cell against its scored task's hidden suite → the per-run AC-pass-rate series. */
function cellPassRates(cell: MatrixCell): number[] {
  const fixture = loadGraderFixture(cell.task.graderDir);
  return cell.producedRoots.map((root) => {
    const result = grade(root, fixture);
    return result.total === 0 ? 0 : result.passed / result.total;
  });
}

/** Aggregate counts (met/total) over a cell's runs — the AC15 R2 coverage source. Summed across runs. */
function cellGrade(cell: MatrixCell): CellGrade {
  const fixture = loadGraderFixture(cell.task.graderDir);
  let passed = 0;
  let total = 0;
  for (const root of cell.producedRoots) {
    const result = grade(root, fixture);
    passed += result.passed;
    total += result.total;
  }
  return { regime: cell.regime, arm: cell.arm, passed, total };
}

/** Assemble the matrix into the source-of-truth scoreboard artifact (claims + per-regime + R3 + r2Coverage). */
function assemble(cells: MatrixCell[], stats: StatsConfig): ScoreboardArtifact {
  const passRates = new Map<string, number[]>();
  for (const cell of cells) passRates.set(key(cell.regime, cell.arm), cellPassRates(cell));

  const scoreboardStats: ScoreboardStats = {
    claims: buildClaims(passRates, stats.bootstrap),
    verdictConfig: stats.verdict,
    regimes: buildRegimes(cells),
    r3: buildR3(cells, passRates, stats.bootstrap),
  };

  const grades: CellGrade[] = cells.map(cellGrade);
  return assembleScoreboard(grades, scoreboardStats);
}

/** A stable (regime × arm) key for the pass-rate map. */
function key(regime: Regime, arm: Arm): string {
  return `${regime}:${arm}`;
}

/**
 * The C1–C4 claim stats (doc 06 §4): paired deltas of AC-pass-rate. C1/C2/C3 are B−A on R0/R1prime/R2; C4 is
 * C−B on R3. A claim whose cells are absent (or unevenly sized) degrades to a defined zero-delta honest-null.
 */
function buildClaims(
  passRates: Map<string, number[]>,
  bootstrap: BootstrapConfig,
): ScoreboardStats["claims"] {
  return {
    c1: claim(passRates, "R0", "B", "A", bootstrap),
    c2: claim(passRates, "R1prime", "B", "A", bootstrap),
    c3: claim(passRates, "R2", "B", "A", bootstrap),
    c4: claim(passRates, "R3", "C", "B", bootstrap),
  };
}

/** One claim's paired delta (treatment − baseline) on a regime, or a zero-delta null when cells are missing. */
function claim(
  passRates: Map<string, number[]>,
  regime: Regime,
  treatment: Arm,
  baseline: Arm,
  bootstrap: BootstrapConfig,
): ClaimStat {
  const t = passRates.get(key(regime, treatment));
  const b = passRates.get(key(regime, baseline));
  if (t === undefined || b === undefined || t.length === 0 || t.length !== b.length) {
    return { delta: nullDelta(bootstrap.ciLevel) };
  }
  return { delta: pairedDelta(t, b, bootstrap) };
}

/** A defined zero-effect paired delta — the honest "no measurable win" when a claim's cells are unavailable. */
function nullDelta(ciLevel: number): ClaimStat["delta"] {
  return { delta: 0, ci95: [0, 0], effectSize: 0, ciHalfWidth: 0, ciLevel };
}

/** Build the per-regime, per-arm aggregated stats (AC3) — AC-pass-rate per cell, plus tokens/turns for R3. */
function buildRegimes(cells: MatrixCell[]): RegimeStats {
  const regimes: RegimeStats = {};
  for (const cell of cells) {
    const arms = (regimes[cell.regime] ??= {});
    const stat: ArmRegimeStat = { acPassRate: aggregate(cellPassRates(cell)) };
    if (cell.regime === "R3") {
      stat.tokens = aggregate(cell.result.runs.map((r) => r.cost.inputTokens + r.cost.outputTokens));
      stat.turns = aggregate(cell.result.runs.map((r) => r.cost.numTurns));
    }
    arms[cell.arm] = stat;
  }
  return regimes;
}

/** Build the R3 moat pairs (AC7): per follow-up, cold (B) + warm (C) summaries + the C−B paired delta. */
function buildR3(
  cells: MatrixCell[],
  passRates: Map<string, number[]>,
  bootstrap: BootstrapConfig,
): ScoreboardStats["r3"] {
  const r3Cells = cells.filter((c) => c.regime === "R3");
  const byArm = new Map<Arm, MatrixCell>();
  for (const cell of r3Cells) byArm.set(cell.arm, cell);
  const cold = byArm.get("B");
  const warm = byArm.get("C");
  if (cold === undefined || warm === undefined) return [];

  const coldRates = passRates.get(key("R3", "B"))!;
  const warmRates = passRates.get(key("R3", "C"))!;
  if (coldRates.length === 0 || coldRates.length !== warmRates.length) return [];

  const moat = pairedDelta(warmRates, coldRates, bootstrap);
  // Lesson reuse: observed if ANY warm run reported the declared lesson id (AC8) — the orchestrator surfaces
  // the signal the grader derives; the per-run gotcha-avoidance probe is the grader's, not re-implemented here.
  const lessonId = warm.task.manifest.lesson?.lessonId;
  const lessonReused =
    lessonId !== undefined && warm.result.runs.some((r) => r.usedMemories.includes(lessonId));

  return [
    {
      followUpTaskId: warm.task.manifest.id,
      // `cold`/`warm` are each arm's summary metric for the follow-up (AC7) — the arm's mean AC-pass-rate as a
      // point delta (self-spread 0). The moat is the paired C−B delta over the same follow-up.
      cold: pointDelta(mean(coldRates), bootstrap.ciLevel),
      warm: pointDelta(mean(warmRates), bootstrap.ciLevel),
      moat,
      lessonReused,
    },
  ];
}

/** Arithmetic mean of a non-empty series (callers guard emptiness). */
function mean(series: readonly number[]): number {
  return series.reduce((sum, x) => sum + x, 0) / series.length;
}

/** A zero-spread paired delta carrying `point` as its estimate — an arm's own summary metric (AC7). */
function pointDelta(point: number, ciLevel: number): ReturnType<typeof nullDelta> {
  return { delta: point, ci95: [point, point], effectSize: 0, ciHalfWidth: 0, ciLevel };
}

/** Write the artifact to disk as `ScoreboardArtifact` (NOT the narrower Scoreboard — keeps r2Coverage, AC15). */
function writeArtifacts(
  scoreboard: ScoreboardArtifact,
  jsonPath: string,
  markdownPath?: string,
): { jsonPath: string; markdownPath?: string } {
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(scoreboard, null, 2) + "\n", "utf8");
  if (markdownPath !== undefined) {
    mkdirSync(dirname(markdownPath), { recursive: true });
    writeFileSync(markdownPath, renderMarkdown(scoreboard) + "\n", "utf8");
    return { jsonPath, markdownPath };
  }
  return { jsonPath };
}

/**
 * Re-read a scoreboard artifact from disk, typed as `ScoreboardArtifact` (NOT `Scoreboard`) so the on-disk
 * r2Coverage (AC15) survives the round-trip AC9 re-reads. Used by tests/CLI to verify the written artifact.
 */
export function readScoreboard(jsonPath: string): ScoreboardArtifact {
  return JSON.parse(readFileSync(jsonPath, "utf8")) as ScoreboardArtifact;
}
