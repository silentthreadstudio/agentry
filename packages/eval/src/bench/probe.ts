// The conduct-once → FOUR-axis value-bench probe (the reshape plan §"one conduct, four scores"). It MIRRORS
// `rightsizing/probe.ts` in structure — controls-first gate (zero conduct spend) → matrix (fixture × repeat) via
// `mapPool` → pure score — and COMPOSES the existing spine (no new runner capability): `runCell` drives ONE conduct
// to SETTLE; `summarizeProducedResult` renders the oracle-free produced tree; `judgeWithRubric` scores it; the
// `injectOracle`+`runOracle` pair runs the held-out correctness floor; `extractSelfReportedDone` reads the overclaim
// signal. The single addition over rightsizing is that this probe derives FOUR signals from the one conduct (A: the
// decision trail, B: the code + oracle, C: overclaim, D: escaped-defect + verify-fire) rather than one shape + one
// result, and it gates TWO judges (a CODE control and a DECISION control) before any conduct spends.
//
// THE CAPTURE-BEFORE-INJECT ORDER IS THE CONTRACT (ADR-001): every read of the agent-visible tree (the decision
// trail, the produced code, the no-leak assertion, the self-report) happens BEFORE `injectOracle`, so the judged
// inputs are oracle-free by construction. A leaked oracle file in the captured tree is an invariant breach, never a
// score.
//
// CONTROLS-FIRST (the credibility spine): before any conduct spends, BOTH judges must prove themselves —
//   - the CODE judge (Axis B): overlay each fixture's golden/broken onto a fresh seed (no `claude -p`), judge, and
//     gate on aaStability(golden) + discrimination(golden, broken). A flattering code judge aborts the batch.
//   - the DECISION judge (Axis A): judge a small set of planted gold/poor DECISION artifacts from the corpus's
//     `_controls/` dir, gating on aaStability(gold) + discrimination(gold, poor). If the controls dir is ABSENT the
//     decision-control gate is SKIPPED with a noted caveat — so the probe still runs before Phase 3 authors them.
// Any gate firing → `buildAbortedBenchArtifact(verdict)`, no matrix.

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Runner } from "../io/port.ts";
import { prepareSandbox, seedSandbox } from "../io/sandbox.ts";
import {
  judgeWithRubric,
  aaStability,
  discrimination,
  DEFAULT_AA_TOLERANCE,
  DEFAULT_GOLD_MIN,
  DEFAULT_BROKEN_MAX,
  DEFAULT_MIN_GAP,
  DEFAULT_CONTROL_REPEATS,
  type JudgeFn,
  type Score,
} from "../judge/index.ts";
import { mapPool } from "../pool.ts";
import { mean } from "../stats.ts";
import type { EvalObserver } from "../store/schema.ts";

import { summarizeProducedResult } from "../conduct/result.ts";
import type { OutcomeFixture } from "../conduct/fixture.ts";
import { runCell, type RunCellOptions } from "../conduct/runner.ts";
import { AGENTRY_CELL, type Cell } from "../conduct/cell.ts";
import { injectOracle, runOracle, relativeFilesUnder } from "../rightsizing/oracle.ts";
import { extractSelfReportedDone } from "../rightsizing/compliance.ts";

import { CODE_RUBRIC, DECISION_RUBRIC } from "./rubric.ts";
import { CONTROLS_DIR, loadBenchFixtures, type BenchFixture } from "./fixture.ts";
import {
  buildAbortedBenchArtifact,
  buildBenchArtifact,
  type BenchArtifact,
  type BenchRecord,
} from "./score.ts";

/** The verdict label for the CODE judge's controls (Axis B) — stamps `bench-code-judge-…` verdict strings. */
const CODE_JUDGE_SUBJECT = "bench-code";
/** The verdict label for the DECISION judge's controls (Axis A) — stamps `bench-decision-judge-…` verdict strings. */
const DECISION_JUDGE_SUBJECT = "bench-decision";

/** The planted decision-control filenames the `_controls/` dir holds (the Axis-A gold↔poor discrimination pair). */
const DECISION_GOLD_FILE = "decision-gold.md";
const DECISION_POOR_FILE = "decision-poor.md";

/** Thrown when the captured agent-visible tree contains an oracle file — the oracle-hiding invariant breached. */
export class OracleLeakError extends Error {
  constructor(fixtureId: string, leaked: readonly string[]) {
    super(`oracle-hiding breached: ${fixtureId} leaked ${leaked.join(", ")} into the agent-visible tree`);
    this.name = "OracleLeakError";
  }
}

// ── Options + result ────────────────────────────────────────────────────────────────────────────────────────────

/** Options for the value-bench probe — the fixture set, the injected runner + two-axis judge, the filters, the knobs. */
export interface BenchProbeOptions {
  /** Directory holding the bench fixtures (`fixtures/bench/`); each `<id>/` subdir loads via the bench loader. */
  fixturesDir: string;
  /** The runner to drive each conduct through — fake (zero API, tests) or live (`claude -p`). */
  runner: Runner;
  /** The judge seam — drives BOTH the controls (code + decision) AND the matrix's per-run Axis-A/B scoring. */
  judge: JudgeFn;
  /** Model id pinned for every JUDGE call; the caller discovers it from env/config. */
  judgeModel?: string;
  /** Resolved repo root holding `plugin/` (the `--plugin-dir` for the Agentry conduct + the bundled mem MCP). */
  pluginDir?: string;
  /** Repeats per fixture (the matrix variance unit, k) AND the A/A control repeat floor. Defaults to 1. */
  k?: number;
  /** Bounded concurrency for the matrix (default 1 = serial). The controls gate stays SERIAL and FIRST. */
  concurrency?: number;
  /** A/A stability tolerance — max population stdev of the gold-judged overalls (default {@link DEFAULT_AA_TOLERANCE}). */
  tol?: number;
  /** The floor the gold judged overall must clear (default {@link DEFAULT_GOLD_MIN}). */
  goldMin?: number;
  /** The ceiling the broken/poor judged overall must stay under (default {@link DEFAULT_BROKEN_MAX}). */
  brokenMax?: number;
  /** The minimum required gold − broken/poor separation (default {@link DEFAULT_MIN_GAP}). */
  minGap?: number;
  /** The conduct cell — defaults to the single Agentry arm. Overridable for tests. */
  cell?: Cell;
  /** Fixture filter: when set, only the fixture with this id is conducted; defaults to every fixture. */
  fixtureFilter?: string;
  /** Model id pinned per CONDUCT run; threaded to `runCell` (distinct from {@link judgeModel}). */
  model?: string;
  /** Hard ceiling (ms) per conduct run; threaded to `runCell`. */
  timeoutMs?: number;
  /** Additive observability seam — the store injects this for events + progress. Default: silent. */
  observer?: EvalObserver;
  /** The run id stamped onto emitted events. */
  runId?: string;
  /** Where the verdict artifact JSON is written. */
  outPath: string;
  /**
   * Where the planted Axis-A decision controls (`decision-gold.md` / `decision-poor.md`) live. Defaults to
   * `<fixturesDir>/_controls/`. When this dir is ABSENT the decision-control gate is SKIPPED with a noted caveat.
   */
  decisionControlsDir?: string;
}

/** The probe result: the emitted artifact, where it was written, and the flat per-run records (the scorer's input). */
export interface BenchProbeResult {
  artifact: BenchArtifact;
  outPath: string;
  /** The per-run records — emitted so any downstream re-aggregation is a PURE function over them, no re-conduct. */
  records: readonly BenchRecord[];
}

/**
 * Drive the value bench end-to-end in the GATED order, writing the verdict artifact to `opts.outPath`. The control
 * gate (the two judges over golden/broken + gold/poor overlays) spends judge-tokens but ZERO conduct tokens; only
 * when BOTH judges discriminate does the matrix spend on conduct runs.
 */
export async function runBenchProbe(opts: BenchProbeOptions): Promise<BenchProbeResult> {
  const k = opts.k ?? 1;
  const concurrency = opts.concurrency ?? 1;
  const runId = opts.runId ?? "";
  const cell = opts.cell ?? AGENTRY_CELL;
  const fixtures = loadFixtures(opts.fixturesDir, opts.fixtureFilter);

  const emit = (kind: "task-started" | "task-done" | "gate-fired", detail: string): void =>
    opts.observer?.emit?.({ kind, runId, detail, ts: new Date().toISOString() });

  // GATE — CONTROLS FIRST (judge-tokens only, zero conduct spend): BOTH the code judge (Axis B) and the decision
  // judge (Axis A) must agree with themselves and separate good from bad. Any firing aborts the batch with NO score.
  const verdict = await runControls(fixtures, opts, k);
  if (verdict !== null) {
    emit("gate-fired", `controls failed: ${verdict}`);
    const artifact = buildAbortedBenchArtifact(verdict);
    return { artifact, outPath: writeArtifact(opts.outPath, artifact), records: [] };
  }

  // THE MATRIX — fixture × repeat (one conduct each, settle-then-capture). FLATTEN into independent work items, then
  // drive them through `mapPool` (bounded by `concurrency`, default 1 ⇒ serial). Each item runs its own fresh
  // sandbox, so they're parallel-safe; results land at their flat index, preserving fixture/repeat order.
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
    const record = await runMatrixCell(fixture, repeat, cell, opts, runOpts);
    const codeLabel = record.codeScore ? record.codeScore.overall.toFixed(2) : "—";
    const decisionLabel = record.decisionScore ? record.decisionScore.overall.toFixed(2) : "—";
    emit("task-done", `${i}/${total} ${fixture.id} r${repeat} → decision ${decisionLabel} code ${codeLabel}`);
    return record;
  });

  const artifact = buildBenchArtifact(records);
  return { artifact, outPath: writeArtifact(opts.outPath, artifact), records };
}

/**
 * The CONTROLS-FIRST gate, judge-driven and zero conduct spend. Runs BOTH gates serially and first:
 *   1. CODE judge (Axis B) — for EACH fixture, overlay golden/broken onto a fresh seed and judge with CODE_RUBRIC;
 *      gate aaStability(golden ×controlK) + discrimination(mean golden, mean broken).
 *   2. DECISION judge (Axis A) — judge the planted gold/poor DECISION artifacts with DECISION_RUBRIC; gate
 *      aaStability(gold ×controlK) + discrimination(mean gold, mean poor). SKIPPED (with no verdict) when the
 *      controls dir is absent — so the probe runs before Phase 3 authors the planted controls.
 * Returns the PINNED verdict string of the first firing control, or `null` when both judges are stable AND
 * discriminating.
 */
async function runControls(
  fixtures: readonly BenchFixture[],
  opts: BenchProbeOptions,
  k: number,
): Promise<string | null> {
  const tol = opts.tol ?? DEFAULT_AA_TOLERANCE;
  const goldMin = opts.goldMin ?? DEFAULT_GOLD_MIN;
  const brokenMax = opts.brokenMax ?? DEFAULT_BROKEN_MAX;
  const minGap = opts.minGap ?? DEFAULT_MIN_GAP;
  // Judge each overlay this many times and compare MEANS — the judge has real per-draw variance, so a single draw
  // flakes false-negative even when the means separate. Floored independently of the matrix `k` (mirrors rightsizing).
  const controlK = Math.max(k, DEFAULT_CONTROL_REPEATS);

  // 1. CODE judge (Axis B) — per fixture, gold = seed+golden, broken = seed+broken.
  for (const fixture of fixtures) {
    const goldScores: number[] = [];
    for (let i = 0; i < controlK; i++) {
      goldScores.push((await judgeCodeOverlay(fixture, fixture.goldenDir, opts)).overall);
    }
    const aa = aaStability(goldScores, tol, CODE_JUDGE_SUBJECT);
    if (!aa.ok) return aa.verdict!;

    const brokenScores: number[] = [];
    for (let i = 0; i < controlK; i++) {
      brokenScores.push((await judgeCodeOverlay(fixture, fixture.brokenDir, opts)).overall);
    }
    const disc = discrimination(
      mean(goldScores),
      mean(brokenScores),
      goldMin,
      brokenMax,
      minGap,
      CODE_JUDGE_SUBJECT,
    );
    if (!disc.ok) return disc.verdict!;
  }

  // 2. DECISION judge (Axis A) — planted gold/poor decision artifacts. SKIP when the controls dir is absent.
  const decisionControls = loadDecisionControls(opts);
  if (decisionControls !== null) {
    const goldScores: number[] = [];
    for (let i = 0; i < controlK; i++) {
      goldScores.push((await judgeDecision(decisionControls.gold, opts)).overall);
    }
    const aa = aaStability(goldScores, tol, DECISION_JUDGE_SUBJECT);
    if (!aa.ok) return aa.verdict!;

    const poorScores: number[] = [];
    for (let i = 0; i < controlK; i++) {
      poorScores.push((await judgeDecision(decisionControls.poor, opts)).overall);
    }
    const disc = discrimination(
      mean(goldScores),
      mean(poorScores),
      goldMin,
      brokenMax,
      minGap,
      DECISION_JUDGE_SUBJECT,
    );
    if (!disc.ok) return disc.verdict!;
  }

  return null;
}

/**
 * The planted Axis-A decision controls — a clearly-good vs clearly-poor decision artifact + the task prompt the
 * judge frames them against. Loaded from `<decisionControlsDir>/{decision-gold.md, decision-poor.md}`; returns
 * `null` when the dir (or either file) is absent — the caller then SKIPS the decision-control gate with that caveat.
 * Each control is framed with a NEUTRAL task prompt so the judge scores the artifact's intrinsic decision quality,
 * not its fit to a specific fixture.
 */
function loadDecisionControls(opts: BenchProbeOptions): { gold: string; poor: string } | null {
  const dir = opts.decisionControlsDir ?? join(opts.fixturesDir, CONTROLS_DIR);
  const goldPath = join(dir, DECISION_GOLD_FILE);
  const poorPath = join(dir, DECISION_POOR_FILE);
  if (!existsSync(goldPath) || !existsSync(poorPath)) return null;
  return { gold: readFileSync(goldPath, "utf8"), poor: readFileSync(poorPath, "utf8") };
}

/** The neutral task prompt the planted decision controls are judged against (their quality is intrinsic). */
const DECISION_CONTROL_PROMPT =
  "Evaluate the decision quality of the following design/spec artifact for the engineering task it addresses.";

/** Judge a planted decision artifact with the DECISION rubric (Axis A control). */
function judgeDecision(artifactText: string, opts: BenchProbeOptions): Promise<Score> {
  return judgeWithRubric(DECISION_RUBRIC, DECISION_CONTROL_PROMPT, artifactText, judgeOpts(opts));
}

/**
 * Produce a CODE control overlay tree WITHOUT a conduct run and judge it with the CODE rubric. Seeds a fresh
 * sandbox from the fixture's `seed/`, overlays `overlayDir` (`golden/` or `broken/`), renders it oracle-free with
 * `summarizeProducedResult`, and judges it. The sandbox is torn down in a `finally`. Spends only judge-tokens.
 */
async function judgeCodeOverlay(
  fixture: BenchFixture,
  overlayDir: string,
  opts: BenchProbeOptions,
): Promise<Score> {
  const sandbox = prepareSandbox();
  try {
    if (existsSync(fixture.seedDir)) seedSandbox(sandbox.workingDir, fixture.seedDir);
    seedSandbox(sandbox.workingDir, overlayDir);
    const produced = summarizeProducedResult(sandbox.workingDir, asOutcomeFixtureView(fixture));
    return await judgeWithRubric(CODE_RUBRIC, fixture.prompt, produced.text, judgeOpts(opts));
  } finally {
    rmSync(sandbox.workingDir, { recursive: true, force: true });
  }
}

/**
 * Run ONE matrix cell (fixture × repeat) through the conduct-once → four-axis pipeline and build the
 * {@link BenchRecord}. The ORDER is the contract AND the oracle-hiding guarantee:
 *   runCell (conduct to SETTLE) → CAPTURE (assert no oracle leak; read the decision trail; render the produced tree;
 *     read the self-report + verify-fire) → JUDGE A (decision trail, if any) → JUDGE B (produced tree) → OPTIONAL
 *     CORRECTNESS (inject + run oracle) → escapedDefect → assemble. Everything that reads the agent-visible tree
 *     happens BEFORE the oracle is injected, so both judged inputs are oracle-free. Sandbox torn down in `finally`.
 */
async function runMatrixCell(
  fixture: BenchFixture,
  repeat: number,
  cell: Cell,
  opts: BenchProbeOptions,
  runOpts: RunCellOptions,
): Promise<BenchRecord> {
  const { result, sandboxDir } = await runCell(asOutcomeFixtureView(fixture), cell, opts.runner, runOpts);
  try {
    // CAPTURE (capture-before-inject): everything that reads the agent-visible tree happens BEFORE the oracle inject.
    // (a) oracle-hiding: prove the captured tree holds no oracle file. A leak is an invariant breach, not a score.
    assertNoOracleLeak(fixture, sandboxDir);

    // (b) the DECISION TRAIL — read every work-folder spec/plan/adr into one blob. EMPTY ⇒ the conduct wrote no
    // trail (e.g. a one-shot) ⇒ no decisionScore (the record is excluded from Axis A, never scored as a 0).
    const decisionTrail = readDecisionTrail(sandboxDir);

    // (c) render the produced (oracle-free) tree, then (d) the self-report + (e) the verify-fire signal.
    const produced = summarizeProducedResult(sandboxDir, asOutcomeFixtureView(fixture));
    const selfReportedDone = extractSelfReportedDone(result.streamPath);
    const verifyFired = readVerifyFired(result.streamPath);

    // JUDGE A — only when a decision trail exists.
    const decisionScore =
      decisionTrail.length > 0
        ? await judgeWithRubric(DECISION_RUBRIC, fixture.prompt, decisionTrail, judgeOpts(opts))
        : undefined;

    // JUDGE B — the produced code tree (the result-quality signal).
    const codeScore = await judgeWithRubric(CODE_RUBRIC, fixture.prompt, produced.text, judgeOpts(opts));

    // OPTIONAL CORRECTNESS, POST-CAPTURE/POST-JUDGE: inject the held-out oracle and run it as the correctness floor.
    injectOracle(sandboxDir, fixture.oracleDir);
    const oraclePass = runOracle(sandboxDir, fixture.oracleCmd, fixture.oracleTimeoutMs).pass;

    const escapedDefect = fixture.bugProne && selfReportedDone && !oraclePass;

    const record: BenchRecord = {
      fixtureId: fixture.id,
      repeat,
      bugProne: fixture.bugProne,
      selfReportedDone,
      ...(decisionScore !== undefined ? { decisionScore } : {}),
      codeScore,
      oraclePass,
      verifyFired,
      escapedDefect,
      ...(result.cost !== undefined ? { cost: result.cost } : {}),
    };
    return record;
  } finally {
    // Teardown: reap the sandbox even on a mid-cell failure — no tmp leak across the matrix.
    rmSync(sandboxDir, { recursive: true, force: true });
  }
}

/**
 * Read the conduct's DECISION TRAIL into one text blob (Axis A's judged input): every
 * `<sandbox>/.agentry/work/<slug>/{spec.md, plan.md, adr/*.md}` concatenated with a `--- <path> ---` header per file
 * (so the judge sees provenance), sorted for determinism. ABSENT/empty (no `.agentry/work/`, or only non-trail
 * files) ⇒ an empty string — the signal that the conduct wrote no trail (a one-shot), which the caller turns into
 * an ABSENT decisionScore. Pure fs reads; no mutation.
 */
function readDecisionTrail(sandboxDir: string): string {
  const workRoot = join(sandboxDir, ".agentry", "work");
  if (!existsSync(workRoot) || !statSync(workRoot).isDirectory()) return "";

  const sections: { path: string; content: string }[] = [];
  for (const slug of readdirSync(workRoot)) {
    const slugDir = join(workRoot, slug);
    if (!statSync(slugDir).isDirectory()) continue;
    for (const name of ["spec.md", "plan.md"]) {
      const file = join(slugDir, name);
      if (existsSync(file) && statSync(file).isFile()) {
        sections.push({ path: join(slug, name), content: readFileSync(file, "utf8") });
      }
    }
    const adrDir = join(slugDir, "adr");
    if (existsSync(adrDir) && statSync(adrDir).isDirectory()) {
      for (const adr of readdirSync(adrDir)) {
        const file = join(adrDir, adr);
        if (adr.endsWith(".md") && statSync(file).isFile()) {
          sections.push({ path: join(slug, "adr", adr), content: readFileSync(file, "utf8") });
        }
      }
    }
  }

  return sections
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((s) => `--- ${s.path} ---\n${s.content}`)
    .join("\n\n");
}

/**
 * The VERIFY-FIRE heuristic (Axis D process signal): did the run's stream show the conductor dispatch the verifier
 * OR run a verify/assemble step? Parses the teed `stream.jsonl` and returns true iff EITHER:
 *   - a `tool_use` block dispatches the verifier agent — a `Task`/`Agent` tool whose `input.subagent_type` (or its
 *     prompt/description) names `agentry:verifier`; OR
 *   - a `verify` / `assemble` skill marker appears in the stream — a Skill/SlashCommand tool_use naming
 *     `agentry:verify` / `agentry:assemble`, or that marker in the assistant text.
 * A missing/unreadable stream ⇒ false (no transcript made no verify claim). This is a PROCESS signal (did the
 * separate-verifier step happen), distinct from whether the work was actually correct (the oracle owns that).
 */
function readVerifyFired(streamPath: string): boolean {
  if (!existsSync(streamPath)) return false;
  const VERIFY_RE = /agentry:(verifier|verify|assemble)|\bverifier\b/i;
  for (const line of readFileSync(streamPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: { message?: { content?: unknown } };
    try {
      ev = JSON.parse(line) as typeof ev;
    } catch {
      continue;
    }
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string" && VERIFY_RE.test(block.text)) return true;
      if (block.type === "tool_use") {
        // The tool name itself (a Skill/SlashCommand named for verify/assemble) or its input (a Task dispatch whose
        // subagent_type / prompt names the verifier) — JSON-stringify the block so any nested field is matched.
        if (VERIFY_RE.test(JSON.stringify(block))) return true;
      }
    }
  }
  return false;
}

/** The judge options threaded to every {@link judgeWithRubric} call — the injected seam + the pinned judge model. */
function judgeOpts(opts: BenchProbeOptions): { judge: JudgeFn; model?: string } {
  return { judge: opts.judge, ...(opts.judgeModel !== undefined ? { model: opts.judgeModel } : {}) };
}

/**
 * The oracle-hiding invariant, enforced on the captured (pre-injection) agent-visible tree: NONE of the fixture's
 * held-out oracle files may appear in the sandbox the agent saw. Compared against both the bare path and the
 * injected `oracle/<path>` prefix. A non-empty leak throws {@link OracleLeakError}.
 */
function assertNoOracleLeak(fixture: BenchFixture, sandboxDir: string): void {
  const captured = new Set(relativeFilesUnder(sandboxDir));
  const leaked = relativeFilesUnder(fixture.oracleDir).filter((f) => captured.has(f) || captured.has(`oracle/${f}`));
  if (leaked.length > 0) throw new OracleLeakError(fixture.id, leaked);
}

/**
 * Adapt a {@link BenchFixture} to the {@link OutcomeFixture} VIEW the two reused functions read: `runCell` reads
 * `prompt` + `seedDir`; `summarizeProducedResult` reads `id`. Neither reads `shape`/`kind` (placeholder values),
 * so this is a thin field projection, not a duplicated fixture model.
 */
function asOutcomeFixtureView(fixture: BenchFixture): OutcomeFixture {
  return {
    id: fixture.id,
    prompt: fixture.prompt,
    shape: "one-shot",
    kind: "feature",
    oracleCmd: fixture.oracleCmd,
    oracleTimeoutMs: fixture.oracleTimeoutMs,
    seedDir: fixture.seedDir,
    oracleDir: fixture.oracleDir,
    goldenDir: fixture.goldenDir,
    brokenDir: fixture.brokenDir,
  };
}

/**
 * Load the selected bench fixtures under `fixturesDir` (the loader validates per-fixture structure, throwing loudly
 * on a malformed one). `fixtureFilter`, when set, restricts the set to the single matching fixture id — an unknown
 * id is a loud `RangeError` so a typo surfaces rather than running an empty (and silently $0) matrix.
 */
function loadFixtures(fixturesDir: string, fixtureFilter: string | undefined): BenchFixture[] {
  const all = loadBenchFixtures(fixturesDir);
  if (fixtureFilter === undefined) return all;
  const selected = all.filter((fx) => fx.id === fixtureFilter);
  if (selected.length === 0) {
    throw new RangeError(`runBenchProbe: fixture "${fixtureFilter}" not found under ${fixturesDir}`);
  }
  return selected;
}

/** Serialize the verdict artifact to pretty JSON at `path`. Returns the path. */
function writeArtifact(path: string, artifact: BenchArtifact): string {
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return path;
}
