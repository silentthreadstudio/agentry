// The conduct-and-judge probe (ADR-001 — the UNIFICATION CORE). It conducts each task ONCE (settle-then-extract),
// reads the routed `Shape` from the settled work-folder artifacts AND judges the produced tree through the shared
// judge engine (T-01), runs the optional functional floor, gates on the controls-first ladder, then scores
// results-gated via T-02. It COMPOSES existing machinery — no new runner capability (ADR-001 R1a):
//   - `runCell` (outcome/runner.ts) drives ONE conduct to SETTLE (`runToCompletion: true`);
//   - `extractShape` (rightsizing/extract.ts) reads the settled work folder for the routed Shape;
//   - `judgeWithRubric` (T-01) scores the produced tree against the 4-dim outcome rubric;
//   - `buildScoredArtifact` / `buildAbortedArtifact` (T-02) own the bucketing math + the gated-abort artifact.
//
// THE FLOW (mirrors outcome/probe.ts's gated order):
//   1. CONTROLS-FIRST (zero conduct spend — judge-tokens only): for each fixture, overlay golden + broken trees onto
//      a fresh seed (no `claude -p`), judge each via the engine, run aaStability (judge golden k times) +
//      discrimination (golden HIGH, broken LOW, gap ≥ minGap). ANY failure aborts the BATCH with the firing
//      control's PINNED verdict and NO score (`buildAbortedArtifact`).
//   2. THE MATRIX (settle-then-extract, ADR-001) per (fixture × repeat) via `mapPool(concurrency)`:
//      runCell (conduct to SETTLE) → CAPTURE (assert no oracle leak; render the produced tree) → extractShape over
//      the SETTLED work folder (ctx = {resultSubtype, producedTreeNonEmpty}) → judge the produced tree → OPTIONAL
//      functional floor (inject + run oracle) → assemble a RightsizingRunRecord. A DegenerateRunError OR a no-settle
//      run yields `shape: undefined` ⇒ T-02 buckets it `indeterminate` (its own terminal category, never a one-shot).
//   3. SCORE via `buildScoredArtifact(records)`.
//
// THE CAPTURE-BEFORE-INJECT ORDER IS THE CONTRACT (ADR-001): the judge reads the produced tree BEFORE the floor
// injects the held-out oracle, so the judged input is oracle-free by construction. A leaked oracle file in the
// captured tree is an invariant breach ({@link OracleLeakError}), never a score.
//
// AC10 BOUNDARY: the shape is read from artifacts, the result from the judge — NEVER crossed. No grade leaks into
// the shape read; no artifact read leaks into the judged score.
//
// The `runner` and the `judge` are both INJECTED (live `claude -p` from the R1 script; fakes/replay in tests = zero
// spend), so the whole probe is forced-testable. The controls' overlay step is a real fs op and spends $0 regardless
// of the runner — only the judge spends judge-tokens.

import { existsSync, rmSync, writeFileSync } from "node:fs";

import type { Runner } from "../io/port.ts";
import { prepareSandbox, seedSandbox } from "../io/sandbox.ts";
import {
  judgeWithRubric,
  makeRubric,
  aaStability,
  discrimination,
  DEFAULT_AA_TOLERANCE,
  DEFAULT_GOLD_MIN,
  DEFAULT_BROKEN_MAX,
  DEFAULT_MIN_GAP,
  DEFAULT_CONTROL_REPEATS,
  type JudgeFn,
  type Rubric,
  type Score,
} from "../judge/index.ts";
import { mapPool } from "../pool.ts";
import { mean } from "../stats.ts";
import type { EvalObserver } from "../store/schema.ts";

import { OUTCOME_DIMENSIONS, RUBRIC_TEXT } from "../conduct/outcome-rubric.ts";
import { summarizeProducedResult } from "../conduct/result.ts";
import type { OutcomeFixture } from "../conduct/fixture.ts";
import { runCell, type RunCellOptions } from "../conduct/runner.ts";
import { AGENTRY_CELL, type Cell } from "../conduct/cell.ts";

import type { RightsizingFixture } from "./fixture.ts";
import { loadRightsizingFixture } from "./fixture.ts";
import { extractShape, DegenerateRunError, type ExtractContext } from "./extract.ts";
import { injectOracle, runOracle, functionalFloor, relativeFilesUnder } from "./oracle.ts";
import { extractSelfReportedDone } from "./compliance.ts";
import {
  buildScoredArtifact,
  buildAbortedArtifact,
  type RightsizingArtifact,
  type RightsizingRunRecord,
} from "./score.ts";

/** The verdict label for the rightsizing judge's controls — stamps the pinned `rightsizing-judge-…` strings. */
const JUDGE_SUBJECT = "rightsizing";

/**
 * The rubric the conduct-and-judge probe scores produced trees against — the SHARED engine's `Rubric` value built
 * from the 4-dim outcome rubric (T-01 / ADR-002: a rubric is DATA). `makeRubric` derives `max` (= 8) from the
 * fixed 0/1/2 vocabulary, so the engine normalizes `overall = sum / 8` identically for controls + matrix.
 */
const RIGHTSIZING_RUBRIC: Rubric = makeRubric(OUTCOME_DIMENSIONS, RUBRIC_TEXT);

/** Thrown when the captured agent-visible tree contains an oracle file — the ADR-001 oracle-hiding invariant breached. */
export class OracleLeakError extends Error {
  constructor(fixtureId: string, leaked: readonly string[]) {
    super(`oracle-hiding breached: ${fixtureId} leaked ${leaked.join(", ")} into the agent-visible tree`);
    this.name = "OracleLeakError";
  }
}

// ── Options + result ────────────────────────────────────────────────────────────────────────────────────────────

/** Options for the conduct-and-judge probe — the fixture set, the injected runner + judge, the filters, and the knobs. */
export interface RightsizingProbeOptions {
  /** Directory holding the rightsizing fixtures (`fixtures/rightsizing/`); each `<id>/` subdir loads via {@link loadRightsizingFixture}. */
  fixturesDir: string;
  /** The runner to drive each conduct through — replay/fake (zero API, tests) or live (`claude -p`, the R1 script). */
  runner: Runner;
  /**
   * The judge seam (T-01): prompt + model → the model's raw JSON verdict. INJECTED — a canned fn in tests (zero
   * API), the real `claude -p` judge from the R1 script. Drives BOTH the controls (golden/broken) and the matrix's
   * per-run scoring through {@link judgeWithRubric}, so the judged-quality score is the only quality signal.
   */
  judge: JudgeFn;
  /** Model id pinned for every JUDGE call (the rubric judge); the caller discovers it from env/config (T-01). */
  judgeModel?: string;
  /** Resolved `--plugin-dir` for the Agentry conduct (the repo root holding `plugin/`); required when a plugin cell runs. */
  pluginDir?: string;
  /**
   * Repeats per fixture (the matrix variance unit, k). ALSO the A/A control repeat count (the judge scores each
   * fixture's golden tree k times; their spread must agree within `tol`). Defaults to 1.
   */
  k?: number;
  /**
   * BOUNDED-CONCURRENCY for the matrix (default 1 = a serial loop). The matrix runs are independent (each `runCell`
   * prepares a fresh sandbox), so `concurrency > 1` runs that many at once via {@link mapPool}, collecting the SAME
   * records. The controls-first GATE stays SERIAL and FIRST. Keep this modest (3–4) for live runs: each conduct
   * spawns subagents, so a high limit hits API rate limits + heavy machine load.
   */
  concurrency?: number;
  /** A/A stability tolerance — the max population stdev of the golden-judged overalls (default {@link DEFAULT_AA_TOLERANCE}). */
  tol?: number;
  /** The floor the `golden` judged overall must clear (default {@link DEFAULT_GOLD_MIN}). */
  goldMin?: number;
  /** The ceiling the `broken` judged overall must stay under (default {@link DEFAULT_BROKEN_MAX}). */
  brokenMax?: number;
  /** The minimum required `gold − broken` separation (default {@link DEFAULT_MIN_GAP}). */
  minGap?: number;
  /** The conduct cell — defaults to the single Agentry arm (ADR-003 de-bare). Overridable for tests. */
  cell?: Cell;
  /** Fixture filter: when set, only the fixture with this id is conducted; defaults to every fixture under `fixturesDir`. */
  fixtureFilter?: string;
  /** Model id pinned per CONDUCT run; threaded to `runCell` (distinct from {@link judgeModel}). */
  model?: string;
  /** Hard ceiling (ms) per conduct run; threaded to `runCell`. */
  timeoutMs?: number;
  /** Additive observability seam — the store injects this for `events.jsonl` + stdout progress. Default: silent. */
  observer?: EvalObserver;
  /** The run id stamped onto emitted events (matches the store's `runs/<runId>/`). */
  runId?: string;
  /** Where the verdict artifact JSON is written. */
  outPath: string;
}

/** The probe result: the emitted artifact, where it was written, and the flat per-run records (T-05 consumes these). */
export interface RightsizingProbeResult {
  artifact: RightsizingArtifact;
  outPath: string;
  /** The per-run records — emitted so the honesty (overclaim) scorer is a PURE function over them, no re-conduct. */
  records: readonly RightsizingRunRecord[];
}

/**
 * Drive the rightsizing dimension end-to-end in the GATED order (ADR-001), writing the verdict artifact to
 * `opts.outPath`. The control gate (the judge over golden/broken overlays) spends judge-tokens but ZERO conduct
 * tokens; only when EVERY fixture's judge discriminates does the matrix spend on conduct runs.
 */
export async function runRightsizingProbe(opts: RightsizingProbeOptions): Promise<RightsizingProbeResult> {
  const k = opts.k ?? 1;
  const concurrency = opts.concurrency ?? 1;
  const runId = opts.runId ?? "";
  const cell = opts.cell ?? AGENTRY_CELL;
  const fixtures = loadFixtures(opts.fixturesDir, opts.fixtureFilter);

  const emit = (kind: "task-started" | "task-done" | "gate-fired", detail: string): void =>
    opts.observer?.emit?.({ kind, runId, detail, ts: new Date().toISOString() });

  // GATE — CONTROLS FIRST (judge-tokens only, zero conduct spend). For every fixture the judge must agree with
  // itself on golden (A/A) AND separate golden from broken by a clear gap. Any non-discriminating (or noisy)
  // fixture aborts the whole batch with the firing control's PINNED verdict and NO score.
  const verdict = await runControls(fixtures, opts, k);
  if (verdict !== null) {
    emit("gate-fired", `controls failed: ${verdict}`);
    const artifact = buildAbortedArtifact(verdict);
    return { artifact, outPath: writeArtifact(opts.outPath, artifact), records: [] };
  }

  // THE MATRIX — fixture × repeat (one conduct each, settle-then-extract). FLATTEN into independent work items, then
  // drive them through `mapPool` (bounded by `concurrency`, default 1 ⇒ strictly serial). Each item runs its own
  // fresh sandbox (`runCell`), so they're parallel-safe; results land at their flat index, so the collected records
  // keep the SAME fixture / repeat order regardless of which worker finished first.
  const runOpts: RunCellOptions = {
    ...(opts.pluginDir !== undefined ? { pluginDir: opts.pluginDir } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };

  const total = fixtures.length * k;
  const work = fixtures.flatMap((fixture) =>
    Array.from({ length: k }, (_, repeat) => ({ fixture, repeat })),
  );
  const records = await mapPool(work, concurrency, async ({ fixture, repeat }, index) => {
    const i = index + 1;
    emit("task-started", `${i}/${total} ${fixture.id} r${repeat}`);
    const record = await runMatrixCell(fixture, cell, opts, runOpts);
    const shapeLabel = record.shape ?? "indeterminate";
    const resultLabel = record.result ? record.result.overall.toFixed(2) : "—";
    emit("task-done", `${i}/${total} ${fixture.id} r${repeat} → shape ${shapeLabel} quality ${resultLabel}`);
    return record;
  });

  const artifact = buildScoredArtifact(records);
  return { artifact, outPath: writeArtifact(opts.outPath, artifact), records };
}

/**
 * The CONTROLS-FIRST gate, judge-driven and zero conduct spend. For each fixture:
 *   - A/A stability: judge the `golden` produced tree `controlK` times; the overall scores must agree within `tol`
 *     (a scatter ⇒ `rightsizing-judge-measures-noise`).
 *   - discrimination: judge a `golden` and a `broken` produced tree (on MEANS over `controlK` draws); golden must
 *     score ≥ `goldMin`, broken ≤ `brokenMax`, and `golden − broken ≥ minGap` (a collapsed gap ⇒
 *     `rightsizing-judge-cannot-discriminate`).
 * The golden/broken trees are produced by OVERLAY onto a fresh seed (no `claude -p`), so the control spends only
 * judge-tokens. Returns the PINNED verdict string of the first firing control, or `null` when every fixture's
 * judge is stable AND discriminating. Serial + first — a single abort short-circuits before any conduct run.
 */
async function runControls(
  fixtures: readonly RightsizingFixture[],
  opts: RightsizingProbeOptions,
  k: number,
): Promise<string | null> {
  const tol = opts.tol ?? DEFAULT_AA_TOLERANCE;
  const goldMin = opts.goldMin ?? DEFAULT_GOLD_MIN;
  const brokenMax = opts.brokenMax ?? DEFAULT_BROKEN_MAX;
  const minGap = opts.minGap ?? DEFAULT_MIN_GAP;
  // Judge each overlay this many times and compare MEANS — the judge has real per-draw variance, so a single draw
  // flakes false-negative even when the means separate cleanly. Floored independently of the matrix `k` so the gate
  // stays robust on a `k=1` slice; mirrors the matrix's own k-fold averaging.
  const controlK = Math.max(k, DEFAULT_CONTROL_REPEATS);

  for (const fixture of fixtures) {
    // A/A — judge the golden produced tree controlK times; the overalls must agree within tolerance (the judge must
    // not scatter on identical input). These same golden draws are reused as the gold sample for discrimination.
    const goldScores: number[] = [];
    for (let i = 0; i < controlK; i++) {
      goldScores.push((await judgeOverlay(fixture, fixture.goldenDir, opts)).overall);
    }
    const aa = aaStability(goldScores, tol, JUDGE_SUBJECT);
    if (!aa.ok) return aa.verdict!;

    // discrimination on MEANS — judge the broken tree controlK times; mean(golden) HIGH, mean(broken) LOW, gap ≥
    // minGap. Averaging cancels the per-draw judge noise; a judge that truly can't separate a planted outcome gap
    // still fails (its means won't separate), so the batch aborts before any conduct spend.
    const brokenScores: number[] = [];
    for (let i = 0; i < controlK; i++) {
      brokenScores.push((await judgeOverlay(fixture, fixture.brokenDir, opts)).overall);
    }
    const disc = discrimination(mean(goldScores), mean(brokenScores), goldMin, brokenMax, minGap, JUDGE_SUBJECT);
    if (!disc.ok) return disc.verdict!;
  }
  return null;
}

/**
 * Produce a control overlay tree WITHOUT a conduct run and judge it. Seeds a fresh sandbox from the fixture's
 * `seed/`, overlays `overlayDir` (`golden/` or `broken/`) — exactly the tree a correct/broken build would have left
 * — renders it with {@link summarizeProducedResult} (oracle-free: the oracle is never injected on the control path),
 * and judges it. The sandbox is torn down in a `finally`. Spends only judge-tokens.
 */
async function judgeOverlay(
  fixture: RightsizingFixture,
  overlayDir: string,
  opts: RightsizingProbeOptions,
): Promise<Score> {
  const sandbox = prepareSandbox();
  try {
    if (existsSync(fixture.seedDir)) seedSandbox(sandbox.workingDir, fixture.seedDir);
    seedSandbox(sandbox.workingDir, overlayDir);
    const produced = summarizeProducedResult(sandbox.workingDir, asOutcomeFixtureView(fixture));
    return await judgeWithRubric(RIGHTSIZING_RUBRIC, fixture.prompt, produced.text, judgeOpts(opts));
  } finally {
    rmSync(sandbox.workingDir, { recursive: true, force: true });
  }
}

/**
 * Run ONE matrix cell (fixture × repeat) through the conduct-and-judge pipeline (ADR-001) and build the
 * {@link RightsizingRunRecord}. The ORDER is the contract AND the oracle-hiding guarantee:
 *   runCell (conduct to SETTLE) → CAPTURE (assert no oracle leak + render the produced tree) → READ shape from the
 *     settled work folder (extractShape; DegenerateRunError ⇒ shape undefined ⇒ indeterminate) → JUDGE the produced
 *     tree → OPTIONAL functional floor (inject + run oracle) → assemble the record.
 * Everything that reads the agent-visible tree (capture + shape read) happens BEFORE the floor injects the oracle,
 * so the judged input is oracle-free and the floor cannot pollute either signal. The sandbox is torn down in a
 * `finally`. The two facets are NEVER crossed (AC10): the shape comes from the artifacts, the result from the judge.
 */
async function runMatrixCell(
  fixture: RightsizingFixture,
  cell: Cell,
  opts: RightsizingProbeOptions,
  runOpts: RunCellOptions,
): Promise<RightsizingRunRecord> {
  const { result, sandboxDir } = await runCell(asOutcomeFixtureView(fixture), cell, opts.runner, runOpts);
  try {
    // CAPTURE (ADR-001): everything that reads the agent-visible tree happens BEFORE the oracle is injected.
    // (a) oracle-hiding: snapshot the agent-visible tree now and PROVE it holds no oracle file. A leak here means
    // the seed (or the agent) wrote a held-out file the agent could read — an invariant breach, not a score.
    assertNoOracleLeak(fixture, sandboxDir);

    // (b) READ the routed shape from the SETTLED work folder (the artifact facet). A DegenerateRunError (no
    // work-folder artifact AND no clean settle) ⇒ shape undefined ⇒ T-02 buckets the record `indeterminate`
    // (its own terminal category), NEVER a silent one-shot.
    const shape = readShape(sandboxDir, result.resultSubtype, result.producedTreeNonEmpty);

    // (c) render the produced (oracle-free) tree, then JUDGE it (the result facet — the ONLY quality signal). Read
    // on the captured, oracle-free produced tree; the score never depends on the artifact read or the floor.
    const produced = summarizeProducedResult(sandboxDir, asOutcomeFixtureView(fixture));
    const judged = await judgeWithRubric(RIGHTSIZING_RUBRIC, fixture.prompt, produced.text, judgeOpts(opts));

    // OPTIONAL FLOOR, POST-CAPTURE/POST-JUDGE: inject the held-out oracle and run it as a LOOSE functional floor
    // ("did the produced code run / not crash"). Carried as a subordinate auxiliary signal — the score NEVER
    // depends on it (T-02 reads the judged overall, not the floor).
    injectOracle(sandboxDir, fixture.oracleDir);
    functionalFloor(runOracle(sandboxDir, fixture.oracleCmd, fixture.oracleTimeoutMs));

    // (d) self-reported-done — from the teed stream (the overclaim signal: said done + judged result too low).
    const selfReportedDone = extractSelfReportedDone(result.streamPath);

    const record: RightsizingRunRecord = {
      fixtureId: fixture.id,
      correctFloor: fixture.correctFloor,
      ...(shape !== undefined ? { shape } : {}),
      result: judged,
      selfReportedDone,
      ...(fixture.trap !== undefined ? { trap: fixture.trap } : {}),
      ...(result.cost !== undefined ? { cost: result.cost } : {}),
    };
    return record;
  } finally {
    // Teardown (ADR-001): reap the sandbox even on a mid-cell failure — no tmp leak across the matrix.
    rmSync(sandboxDir, { recursive: true, force: true });
  }
}

/**
 * Read the routed shape from the settled work folder, mapping the indeterminate trigger to `undefined`. A
 * {@link DegenerateRunError} (a no-artifact run that did not settle cleanly) is the indeterminate marker T-02 turns
 * into the `indeterminate` terminal category — it is caught here and surfaced as an ABSENT shape, never re-thrown
 * (a degenerate run is a valid scored row, not a probe crash) and never silently coerced to `one-shot`.
 */
function readShape(
  sandboxDir: string,
  resultSubtype: string | undefined,
  producedTreeNonEmpty: boolean,
): RightsizingRunRecord["shape"] {
  const ctx: ExtractContext = {
    ...(resultSubtype !== undefined ? { resultSubtype } : {}),
    producedTreeNonEmpty,
  };
  try {
    return extractShape(sandboxDir, ctx);
  } catch (err) {
    if (err instanceof DegenerateRunError) return undefined;
    throw err;
  }
}

/** The judge options threaded to every {@link judgeWithRubric} call — the injected seam + the pinned judge model. */
function judgeOpts(opts: RightsizingProbeOptions): { judge: JudgeFn; model?: string } {
  return { judge: opts.judge, ...(opts.judgeModel !== undefined ? { model: opts.judgeModel } : {}) };
}

/**
 * The oracle-hiding invariant, enforced on the captured (pre-injection) agent-visible tree: NONE of the fixture's
 * held-out oracle files may appear in the sandbox the agent saw. Compared against both the bare path and the
 * injected `oracle/<path>` prefix. A non-empty leak throws {@link OracleLeakError} — a leak is a contract breach,
 * not a fail to score around.
 */
function assertNoOracleLeak(fixture: RightsizingFixture, sandboxDir: string): void {
  const captured = new Set(relativeFilesUnder(sandboxDir));
  const leaked = relativeFilesUnder(fixture.oracleDir).filter((f) => captured.has(f) || captured.has(`oracle/${f}`));
  if (leaked.length > 0) throw new OracleLeakError(fixture.id, leaked);
}

/**
 * Adapt a {@link RightsizingFixture} to the {@link OutcomeFixture} VIEW the two reused functions read: `runCell`
 * reads `prompt` + `seedDir`; `summarizeProducedResult` reads `id`. Neither reads `shape`/`kind` (placeholder
 * values), so this is a thin field projection, not a duplicated fixture model — the reused outcome modules are
 * deleted later by T-10, so importing + adapting them is the intended composition (the contract's "reuse, do not
 * duplicate").
 */
function asOutcomeFixtureView(fixture: RightsizingFixture): OutcomeFixture {
  return {
    id: fixture.id,
    prompt: fixture.prompt,
    shape: fixture.correctFloor,
    kind: fixture.kind ?? "feature",
    oracleCmd: fixture.oracleCmd,
    oracleTimeoutMs: fixture.oracleTimeoutMs,
    seedDir: fixture.seedDir,
    oracleDir: fixture.oracleDir,
    goldenDir: fixture.goldenDir,
    brokenDir: fixture.brokenDir,
  };
}

/**
 * Load the selected rightsizing fixtures under `fixturesDir` (the unified loader validates the corpus spread +
 * per-fixture structure, throwing loudly on a malformed one). `fixtureFilter`, when set, restricts the set to the
 * single matching fixture id — the loud-fail path for an unknown id is a `RangeError` so the caller surfaces a typo
 * rather than running an empty (and silently $0) matrix.
 */
function loadFixtures(fixturesDir: string, fixtureFilter: string | undefined): RightsizingFixture[] {
  const all = loadRightsizingFixture(fixturesDir);
  if (fixtureFilter === undefined) return all;
  const selected = all.filter((fx) => fx.id === fixtureFilter);
  if (selected.length === 0) {
    throw new RangeError(`runRightsizingProbe: fixture "${fixtureFilter}" not found under ${fixturesDir}`);
  }
  return selected;
}

/** Serialize the verdict artifact to pretty JSON at `path`. Returns the path. */
function writeArtifact(path: string, artifact: RightsizingArtifact): string {
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return path;
}

/** Re-export a barrel of the moved-here surface the contract exposes (so consumers import from `rightsizing/probe.ts`). */
export { extractShape, extractKind, DegenerateRunError } from "./extract.ts";
export { injectOracle, runOracle, functionalFloor, relativeFilesUnder } from "./oracle.ts";
export { shapeAwareCompliance, extractSelfReportedDone } from "./compliance.ts";
export type { ExtractContext } from "./extract.ts";
