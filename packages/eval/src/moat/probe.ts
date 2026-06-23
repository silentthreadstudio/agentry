// The moat (memory-hygiene) probe — drives the dimension end-to-end in the GATED order, mirroring the routing
// probe. Per task it runs TWO warm conductor runs in fresh sandboxes: one with a fork-resolving RELEVANT fact
// seeded, one with an irrelevant DECOY. It extracts each run's routed shape (the routing extractor, over the work
// folder) and whether recall LANDED the seed (the recall detector), then gates: seed-landing (validity) and
// decoy discrimination (power). Only if both pass does it score the compound rate.
//
// The `Runner` is INJECTED (live `claude -p` from the command; a replay runner in tests = zero spend). The probe
// owns the gated flow + the per-run orchestration; the pure scoring/gates live in artifact.ts / control.ts.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { Runner, Sandbox } from "../io/port.ts";
import { prepareSandbox, seedSandbox } from "../io/sandbox.ts";
import { mapPool } from "../pool.ts";
import { extractShape, DegenerateRunError } from "../conduct/extract.ts";
import { buildConductorPrompt } from "../conductor-prompt.ts";
import type { Shape } from "../conduct/shape.ts";
import { SHAPES_BY_WEIGHT } from "../conduct/shape.ts";
import type { EvalObserver } from "../store/schema.ts";
import { judgeWithRubric, makeRubric, realJudgeFn, DEFAULT_JUDGE_MODEL, type JudgeFn, type Rubric } from "../judge/index.ts";
import { OUTCOME_DIMENSIONS, RUBRIC_TEXT } from "../conduct/outcome-rubric.ts";
import { summarizeProducedResult } from "../conduct/result.ts";
import type { OutcomeFixture } from "../conduct/fixture.ts";
import { RESULT_GOOD_THRESHOLD } from "../rightsizing/score.ts";

import { loadMoatFixture, type MoatTask } from "./fixture.ts";
import { seedFact, type FactSeed } from "./seed.ts";
import { recallLanded, factSurfaced } from "./recall.ts";
import { seedLandingGuard, discriminationGuard, DEFAULT_SEED_LANDING_FLOOR } from "./control.ts";
import {
  buildScoredArtifact, buildAbortedArtifact, writeArtifact, censusRow,
  type MoatArtifact, type MoatOutcome,
} from "./artifact.ts";

/** The model pinned per run (the command discovers it from env/config; a generic default here). */
const DEFAULT_MODEL = "claude-opus-4-8[1m]";

/**
 * The RESULT-QUALITY rubric the moat probe judges a relevant one-shot's produced tree against. It REUSES the shared
 * outcome rubric DATA (the same 4 anchored dimensions + `/8` normalization the rightsizing probe scores by, so
 * `RESULT_GOOD_THRESHOLD` reads identically across both probes) — the APPLY-THE-DECISION clause is threaded into the
 * judge's SUBJECT context per call (the recalled fact text), not baked into the rubric, so the rubric stays the
 * shared value while the judge can still assess "did the code apply the recalled decision".
 */
const MOAT_RESULT_RUBRIC: Rubric = makeRubric(OUTCOME_DIMENSIONS, RUBRIC_TEXT);

/**
 * The apply-the-decision clause prepended to the judge's TASK context for a moat result judgement. A moat compound
 * is only a win if the one-shot result both meets the task intent AND correctly APPLIES the recalled decision a
 * lighter route was justified by — so the judge is told the decision and instructed to score `meetsIntent`/`correct`
 * DOWN when the produced code ignores or contradicts it (a lighter route that dropped the decision is not a win).
 */
function moatJudgeTaskContext(taskPrompt: string, decisionText: string): string {
  return (
    `${taskPrompt}\n\n` +
    `[RECALLED DECISION THE RESULT MUST APPLY]: ${decisionText}\n` +
    "The build routed LIGHTER than its cold baseline because this prior decision settled a fork the task would " +
    "otherwise have to resolve. Score the result GOOD only if the produced code both does what the task asked AND " +
    "correctly applies this recalled decision; if the code ignores or contradicts the decision, score meetsIntent " +
    "and correct DOWN accordingly (a lighter route that dropped the decision is NOT a working compound)."
  );
}

/** Index in the shared weight order (one-shot=0, spec-first=1, decompose=2) — lighter-than-floor reads this. */
function shapeWeight(shape: Shape): number {
  return SHAPES_BY_WEIGHT.indexOf(shape);
}

/**
 * The warm-run directive: prime memory FIRST, and let a recalled decision COLLAPSE a fork it already settled
 * (the compounding behavior under test). Sets only the MODE — the routing decision stays the conductor's. APPENDED
 * to the EXPANDED conductor prompt (`buildConductorPrompt`, which already supplies the auto-pilot framing), so this
 * carries ONLY the moat-specific memory-priming — not a second auto-pilot block.
 */
const MOAT_DIRECTIVE =
  "\n\n[MOAT — MANDATORY MEMORY-FIRST]: Before reading any file, before routing, and before writing any code, your " +
  "VERY FIRST action MUST be to call memory_resync and then memory_recall for this task — this is mandatory and " +
  "non-negotiable (it mirrors the conducting skill's recall-before-routing rule; skipping it makes the run invalid). " +
  "If recalled precedent DECIDES a fork this task would otherwise hide, APPLY that decision and cite it — a fork " +
  "already settled by durable memory is NO LONGER undecided, so do not escalate on its account.";

/**
 * The `--mcp-config` JSON that loads Agentry's BUNDLED memory MCP into the conduct. `--plugin-dir` loads the
 * plugin's skills/commands/agents but NOT its MCP servers, so without this the conductor has no `memory_recall`
 * tool and the seed can never land. The mem server roots project memory at the conduct's cwd (the sandbox
 * workingDir, where `seedFact` wrote), so a recalled fact resolves to the seeded one.
 */
function memMcpConfig(pluginDir: string): string {
  return JSON.stringify({
    mcpServers: { agentry_mem: { command: "node", args: [join(pluginDir, "plugin", "mem", "index.js")] } },
  });
}

/**
 * The pre-registered moat Δ target `W` (ADR-001 §thresholds) — the FALSIFIABLE FORM, written before any run in the
 * tracked `thresholds.json`. `delta` is the calibration number (`null` until the owner sets it from the first run —
 * NEVER invented in advance); `calibrationPending` flags that pending state explicitly. This is a TARGET, not a
 * claimed result: the artifact always reports the honest measured discrimination regardless of `W` (memory
 * `moat-compounds-and-memory-rooting` — do not market the raw number).
 */
export interface MoatThreshold {
  /** The human-readable falsifiable condition (`discrimination ≥ W`). */
  statement: string;
  /** Which measured quantity W gates — `discrimination` (compoundRate − decoyLightenRate). */
  metric: string;
  /** The Δ target number, or `null` when uncalibrated (set by the first run; never fabricated here). */
  delta: number | null;
  /** Explicitly true while `delta` is unset — so a reader never mistakes "not yet calibrated" for "no target". */
  calibrationPending: boolean;
}

/**
 * The pre-registered success condition carried ON THE PUBLIC ARTIFACT PATH (AC-THRESH). Unlike the routing
 * artifact's `threshold: null` "unset" shape, this is NEVER a bare null: the registered target FORM is always
 * present (`target` is the non-null {@link MoatThreshold} from `thresholds.json`). `pass` is computed only once a
 * `delta` is calibrated — until then `calibrationPending` is true and `pass` is absent (no pass/fail against a
 * number that doesn't exist yet), but the falsifiable condition is still on record.
 */
export interface MoatSuccessCondition {
  /** The pre-registered target — always non-null (the form ships before any run). */
  target: MoatThreshold;
  /** The measured discrimination this run produced, or `null` on an aborted run (a gate fired ⇒ no number). */
  observed: number | null;
  /** True iff `target.delta` is uncalibrated — mirrors `target.calibrationPending`, surfaced for readers/consumers. */
  calibrationPending: boolean;
  /** Whether the measured discrimination cleared `W`; present ONLY when a `delta` is set AND a number was scored. */
  pass?: boolean;
}

/** The path to the tracked, pre-registered `thresholds.json` at the package root (resolved relative to `src/moat/`). */
const THRESHOLDS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "thresholds.json");

/**
 * Load the pre-registered moat target `W` from the tracked `thresholds.json` (the single source — disjoint top-level
 * keys keep it parallel-safe with T-02's `rightsizing`/`X`). Returns the registered {@link MoatThreshold} verbatim;
 * throws if the file or the `moat.W` key is missing, since the FALSIFIABLE TARGET MUST EXIST before a run (AC-THRESH —
 * the public path may never silently fall back to "no target").
 */
export function loadMoatThreshold(path: string = THRESHOLDS_PATH): MoatThreshold {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { moat?: { W?: MoatThreshold } };
  const w = raw.moat?.W;
  if (w === undefined || w === null) {
    throw new Error(`thresholds.json is missing the pre-registered moat target (moat.W) at ${path}`);
  }
  return w;
}

/**
 * Build the public-path success condition from the registered target and the measured discrimination. The target is
 * ALWAYS present (never a bare null — AC-THRESH). `pass` is computed only when `W` is calibrated (`delta` non-null)
 * AND a discrimination number was scored; on an aborted run (`observed === null`) or while calibration is pending,
 * `pass` is absent — the honest "no pass/fail without a number" stance the routing artifact also takes.
 */
export function buildMoatSuccessCondition(target: MoatThreshold, observed: number | null): MoatSuccessCondition {
  const condition: MoatSuccessCondition = {
    target,
    observed,
    calibrationPending: target.calibrationPending,
  };
  if (target.delta !== null && observed !== null) {
    condition.pass = observed >= target.delta;
  }
  return condition;
}

/** Options for one moat probe run. The `Runner` is injected (replay in tests = zero spend; live from the command). */
export interface MoatProbeOptions {
  /** Directory holding `tasks.yaml` + `seeds/<id>/` (the moat fixture). */
  fixtureDir: string;
  /** The runner to drive each warm run through — live or replay. */
  runner: Runner;
  /**
   * The judge seam (T-01) the RESULT-QUALITY gate scores a relevant one-shot's produced tree through. INJECTED — a
   * canned fn in tests (zero API), the real `claude -p` judge in production. Defaults to {@link realJudgeFn}, mirroring
   * the rightsizing probe, so the public path judges for real while tests stay offline.
   */
  judge?: JudgeFn;
  /** Model id pinned for every JUDGE call (the result-quality judge); the caller discovers it from env/config. */
  judgeModel?: string;
  /** Where the artifact JSON is written. */
  outPath: string;
  /** Model id to pin per run (defaults to {@link DEFAULT_MODEL}). */
  model?: string;
  /**
   * Repeats per ARM (k). Each task runs the relevant arm k times AND the decoy arm k times (k×2 conducts per task),
   * so the published rates are stable means over repeats rather than a single high-variance k=1 draw. Defaults to 1.
   */
  runs?: number;
  /**
   * BOUNDED-CONCURRENCY for the conduct matrix (default 1 = the serial loop, preserving today's behavior). Every
   * conduct is independent — each `runWarm` prepares a FRESH sandbox and is seeded with its OWN pre-assigned id-seed
   * (so ULIDs never collide under parallelism) — so `concurrency > 1` runs that many conducts at once via
   * {@link mapPool}, collecting the SAME outcomes (results land at their flat index, so the per-(task,repeat)
   * reassembly is identical to serial). Keep this MODEST (3–4) on LIVE runs: each conduct spawns the conductor +
   * subagents + a judge call + the mem MCP subprocess, so a high limit hits Opus API rate limits + heavy machine load.
   */
  concurrency?: number;
  /** Seed-landing rate FLOOR for GATE 1 (defaults to {@link DEFAULT_SEED_LANDING_FLOOR} = 0.5). */
  seedLandingFloor?: number;
  /** Plugin root to load Agentry from (`--plugin-dir`); absent ⇒ the bare prompt is run (replay tests). */
  pluginDir?: string;
  /** Additive observability seam — the store injects this for `events.jsonl` + stdout progress. Default: silent. */
  observer?: EvalObserver;
  /** The run id stamped onto emitted events (matches the store's `runs/<runId>/`). */
  runId?: string;
  /**
   * Override for the pre-registered `thresholds.json` location (the tracked package root by default). Tests point
   * this at a fixture thresholds file; production reads the committed one — the public path NEVER runs without a
   * registered target.
   */
  thresholdPath?: string;
}

/**
 * The moat artifact AUGMENTED with the pre-registered success condition (AC-THRESH). The base {@link MoatArtifact}
 * (owned by `artifact.ts`) is unchanged; the probe attaches `successCondition` — the pre-registered `W` + the run's
 * measured discrimination + pass/fail — so the public path carries a falsifiable target and never a bare
 * `threshold: null`.
 */
export type MoatPublicArtifact = MoatArtifact & { successCondition: MoatSuccessCondition };

/** The result of a moat probe run: the emitted artifact, where it was written, and the per-task outcomes. */
export interface MoatResult {
  artifact: MoatPublicArtifact;
  outPath: string;
  outcomes: readonly MoatOutcome[];
}

/** What one warm run yields: the routed shape (or null), whether the seed landed, the stream path, and the optional result-quality. */
interface WarmOutcome {
  shape: Shape | null;
  landed: boolean;
  streamPath: string;
  /** Judged-GOOD verdict over the produced tree (relevant arm that routed lighter only); absent otherwise. */
  resultGood?: boolean;
  /** The judged overall behind {@link resultGood} (carried for the census); absent otherwise. */
  resultOverall?: number;
}

/**
 * Run ONE warm conductor run: fresh sandbox, seed the task's codebase + the given fact into the workingDir's
 * project memory (the root `claude -p` reads), route the task, and extract both the routed shape and whether
 * recall landed the seed. A degenerate run (no determinable shape) yields `shape: null` rather than crashing.
 *
 * RESULT-QUALITY gate (RELEVANT arm only — `signature !== undefined`): when the run routed LIGHTER than the task's
 * cold floor (it one-shot, so `terminateOnArtifact` never fired and the run SETTLED, leaving a produced tree), the
 * tree is judged for whether it meets intent AND applies the recalled decision. `resultGood` (judged overall ≥
 * {@link RESULT_GOOD_THRESHOLD}) rides the outcome so a lighter-but-BROKEN one-shot is not scored as a compound win.
 * The decoy arm and any relevant run that did NOT route lighter need no judging (no tree one-shot to assess).
 */
async function runWarm(
  task: MoatTask,
  fact: FactSeed,
  idSeed: number,
  runner: Runner,
  model: string,
  pluginDir: string | undefined,
  fixtureDir: string,
  signature: string | undefined,
  judge: JudgeFn,
  judgeModel: string,
): Promise<WarmOutcome> {
  const sandbox: Sandbox = prepareSandbox();
  const seedDir = join(fixtureDir, "seeds", task.id);
  if (existsSync(seedDir)) seedSandbox(sandbox.workingDir, seedDir);
  // Seed the fact into the conductor's actual project-memory root (the workingDir under `claude -p`).
  seedFact(sandbox.workingDir, fact, idSeed);

  const streamPath = join(sandbox.workingDir, "stream.jsonl");
  // EXPANDED conductor prompt (NOT the `/agentry:go` slash form — that is a 0-turn no-op under `claude -p`, the
  // measurement-validity bug `conductor-prompt.ts` exists to fix; the moat probe regressed to it). The model now
  // actually runs, primes memory per the directive, and routes for real.
  const prompt = pluginDir !== undefined ? buildConductorPrompt(pluginDir, task.prompt) + MOAT_DIRECTIVE : task.prompt;
  const result = await runner.run(
    {
      prompt,
      model,
      streamPath,
      terminateOnArtifact: true,
      ...(pluginDir !== undefined
        ? { pluginDir, permissionMode: "bypassPermissions", mcpConfig: memMcpConfig(pluginDir) }
        : {}),
    },
    sandbox,
  );

  let shape: Shape | null;
  try {
    shape = extractShape(sandbox.workingDir, {
      ...(result.resultSubtype !== undefined ? { resultSubtype: result.resultSubtype } : {}),
      producedTreeNonEmpty: result.producedTreeNonEmpty,
    });
  } catch (err) {
    if (err instanceof DegenerateRunError) shape = null;
    else throw err;
  }

  const { text, tools } = readStream(streamPath);
  const recallFired = tools.some((t) => /memory_recall/.test(t));
  // A relevant run LANDED when its seeded decision provably SURFACED to the conductor — its distinctive signature
  // appears in the run. The conductor may reach the seeded fact via the `memory_recall` MCP tool OR by reading the
  // seeded fact in the project-memory store (`<workingDir>/.agentry/memory/facts/`, where the conductor's Read tool
  // can also see it). BOTH are valid access to the project's durable memory, and the DECOY control attributes the
  // routing effect to the relevant FACT's CONTENT, not the access mechanism (a fork the model resolves from its own
  // priors leaks the decoy → discrimination catches it). Requiring the recall *tool_use* specifically was too narrow
  // — it scored 0/18 even when the seeded decision demonstrably surfaced and the conductor applied it.
  // A decoy carries no signature, so its landing keeps the looser "recall fired + non-empty" check — informational
  // only (the score never reads a decoy's `landed`).
  const landed =
    signature !== undefined ? factSurfaced(text, signature) : recallLanded(text, recallFired);

  // RESULT-QUALITY gate: the RELEVANT arm (signature set) that routed LIGHTER than the cold floor one-shot — so the
  // run settled and the produced tree exists to judge. Judge whether the code meets intent AND applies the recalled
  // decision; resultGood = judged overall cleared the GOOD bar. (No artifact terminated the one-shot, so the tree is
  // there; a relevant run that escalated or a decoy run is not judged — nothing one-shot to assess.)
  const isRelevant = signature !== undefined;
  if (isRelevant && shape !== null && shapeWeight(shape) < shapeWeight(task.coldFloor)) {
    const produced = summarizeProducedResult(sandbox.workingDir, asMoatFixtureView(task));
    const judged = await judgeWithRubric(
      MOAT_RESULT_RUBRIC,
      moatJudgeTaskContext(task.prompt, fact.text),
      produced.text,
      { judge, model: judgeModel },
    );
    return { shape, landed, streamPath, resultGood: judged.overall >= RESULT_GOOD_THRESHOLD, resultOverall: judged.overall };
  }

  return { shape, landed, streamPath };
}

/**
 * Adapt a {@link MoatTask} to the {@link OutcomeFixture} VIEW {@link summarizeProducedResult} reads — it consumes
 * ONLY `id` (for the result's provenance) and never the oracle/overlay fields, so those are inert placeholders here
 * (the moat probe has no oracle path — it judges the produced tree, not a held-out test), mirroring rightsizing's
 * `asOutcomeFixtureView` thin projection.
 */
function asMoatFixtureView(task: MoatTask): OutcomeFixture {
  return {
    id: task.id,
    prompt: task.prompt,
    shape: task.coldFloor,
    kind: "feature",
    oracleCmd: "",
    oracleTimeoutMs: 0,
    seedDir: "",
    oracleDir: "",
    goldenDir: "",
    brokenDir: "",
  };
}

/**
 * Drive the moat probe end-to-end in the GATED order, writing the artifact to `opts.outPath`.
 *
 * Flow: FLATTEN every (task × repeat) into its relevant + decoy conducts → drive them through `mapPool` bounded by
 * `concurrency` (default 1 = serial) → reassemble deterministically into per-(task,repeat) outcomes → seed-landing
 * gate (every relevant run must have recalled its seed) → discrimination gate (relevant compounds where the decoy
 * does not) → score. A gate failure aborts with the pinned verdict and NO compound number (mirrors routing's AC8
 * contract). The flatten-then-reassemble keeps the outcome ordering — and so every downstream number — identical to
 * a strictly serial run, regardless of `concurrency`.
 */
export async function runMoatProbe(opts: MoatProbeOptions): Promise<MoatResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const judge = opts.judge ?? realJudgeFn;
  const judgeModel = opts.judgeModel ?? DEFAULT_JUDGE_MODEL;
  const k = opts.runs ?? 1;
  const concurrency = opts.concurrency ?? 1;
  const seedLandingFloor = opts.seedLandingFloor ?? DEFAULT_SEED_LANDING_FLOOR;
  const tasks = loadMoatFixture(join(opts.fixtureDir, "tasks.yaml"));
  // The pre-registered moat target W is loaded up front — the falsifiable target MUST EXIST before the run.
  const target = loadMoatThreshold(opts.thresholdPath);
  const runId = opts.runId ?? "";
  const emit = (detail: string): void =>
    opts.observer?.emit?.({ kind: "task-done", runId, detail, ts: new Date().toISOString() });

  // FLATTEN the matrix into independent CONDUCT work-items BEFORE launching. For each (task × repeat) there are TWO
  // conducts — a RELEVANT one (carries the fact signature; gets result-judged) and a DECOY one (no signature). The
  // id-seed is PRE-ASSIGNED here, in the SAME order the serial loop produced (relevant, decoy, relevant, decoy, …),
  // so each seeded fact's ULID is unique under parallelism without relying on a wall clock or a shared mutable
  // counter. Each item runs its own fresh sandbox (`runWarm`), so the items are parallel-safe; `mapPool` lands each
  // result at its flat index, so the reassembly below is byte-for-byte identical to the serial output regardless of
  // which worker finished first.
  interface Conduct { taskIndex: number; repeat: number; arm: "relevant" | "decoy"; }
  const conducts: Conduct[] = [];
  tasks.forEach((_task, taskIndex) => {
    for (let repeat = 0; repeat < k; repeat++) {
      conducts.push({ taskIndex, repeat, arm: "relevant" });
      conducts.push({ taskIndex, repeat, arm: "decoy" });
    }
  });
  tasks.forEach((task, taskIndex) => {
    opts.observer?.emit?.({ kind: "task-started", runId, detail: `${taskIndex + 1}/${tasks.length} ${task.id} (k=${k})`, ts: new Date().toISOString() });
  });

  // The flat index IS the pre-assigned id-seed (a simple incrementing counter over the flattened list) — no two
  // conducts share one, so the seeded ULIDs never collide. Drive them through `mapPool` (bounded by `concurrency`,
  // default 1 ⇒ strictly serial, byte-identical to the old `for` loop).
  const warmResults = await mapPool(conducts, concurrency, async (c, idSeed) => {
    const task = tasks[c.taskIndex]!;
    const isRelevant = c.arm === "relevant";
    const fact = isRelevant ? task.relevant : task.decoy;
    // Only the RELEVANT run gets the fact signature (landing must tie to THAT fact); the decoy's landing is
    // "recalled non-empty".
    const signature = isRelevant ? task.factSignature : undefined;
    return runWarm(task, fact, idSeed, opts.runner, model, opts.pluginDir, opts.fixtureDir, signature, judge, judgeModel);
  });

  // REASSEMBLE deterministically: pair each (task × repeat)'s relevant result with its decoy result into the
  // per-(task,repeat) outcome, in task-major / repeat order — IDENTICAL to the serial output, so the gates +
  // aggregation downstream consume the exact same outcomes and produce the same numbers.
  const outcomes: MoatOutcome[] = [];
  let cursor = 0;
  for (const task of tasks) {
    for (let repeat = 0; repeat < k; repeat++) {
      const relevant = warmResults[cursor++]!; // relevant pushed first per (task,repeat)
      const decoy = warmResults[cursor++]!; // decoy pushed second
      const outcome: MoatOutcome = {
        taskId: task.id,
        coldFloor: task.coldFloor,
        // Carry the RESULT-QUALITY verdict (relevant one-shot only) so the results-gated compound can read it: a
        // landed+lighter repeat is a win ONLY when resultGood === true (a lighter-but-broken one-shot is not).
        relevant: {
          shape: relevant.shape,
          landed: relevant.landed,
          ...(relevant.resultGood !== undefined ? { resultGood: relevant.resultGood } : {}),
          ...(relevant.resultOverall !== undefined ? { resultOverall: relevant.resultOverall } : {}),
        },
        decoy: { shape: decoy.shape, landed: decoy.landed },
      };
      outcomes.push(outcome);
      const row = censusRow(outcome);
      // The per-(task,repeat) summary line. Under concurrency it can arrive out of finish-order; that's fine.
      emit(`${task.id} r${repeat} → relevant ${relevant.shape ?? "—"} / decoy ${decoy.shape ?? "—"} (${row.compounded ? "compounded" : "held"})`);
    }
  }

  // GATE 1 — validity: the seed-landing RATE over relevant repeats must clear the floor (a majority must have
  // exercised memory), or the measurement is too weak to trust.
  const landing = seedLandingGuard(outcomes.map((o) => o.relevant.landed), seedLandingFloor);
  if (!landing.ok) {
    opts.observer?.emit?.({ kind: "gate-fired", runId, detail: `seed-landing rate ${landing.landedCount}/${landing.total} below floor ${landing.floor}`, ts: new Date().toISOString() });
    // A gate fired ⇒ NO discrimination number, so `observed` is null and no pass/fail is computed — but the
    // pre-registered target still ships on the public path (the falsifiable form is always on record).
    return emitPublic(opts.outPath, buildAbortedArtifact(landing.verdict!), target, null, outcomes);
  }

  // GATE 2 — power: evaluate over the AGGREGATED rates — the relevant fact must compound (over its landed repeats)
  // where the decoy does not. Score first so the gate reads the same aggregate the artifact publishes.
  const scored = buildScoredArtifact(outcomes, k);
  const disc = discriminationGuard(scored.compoundRate ?? 0, scored.decoyLightenRate ?? 0);
  if (!disc.power) {
    opts.observer?.emit?.({ kind: "gate-fired", runId, detail: `discrimination failed: ${disc.verdict}`, ts: new Date().toISOString() });
    return emitPublic(opts.outPath, buildAbortedArtifact(disc.verdict!), target, null, outcomes);
  }

  // Scored ⇒ the measured discrimination is the run's honest delta; pass/fail is computed against W only when W is
  // calibrated (the artifact reports the real number regardless of the target — never inflated by it).
  return emitPublic(opts.outPath, scored, target, scored.discrimination ?? null, outcomes);
}

/**
 * Single exit point: attach the pre-registered success condition to the base artifact, write the AUGMENTED artifact
 * (so `successCondition` is serialized to disk), and package the result. `observed` is the run's measured
 * discrimination, or `null` when a gate fired (no number ⇒ no pass/fail, but the target still ships).
 */
function emitPublic(
  outPath: string,
  base: MoatArtifact,
  target: MoatThreshold,
  observed: number | null,
  outcomes: readonly MoatOutcome[],
): MoatResult {
  const artifact: MoatPublicArtifact = { ...base, successCondition: buildMoatSuccessCondition(target, observed) };
  writeArtifact(outPath, artifact);
  return { artifact, outPath, outcomes };
}

/** Read a captured `stream.jsonl` into its assistant text + tool_result content and the tool-use sequence. */
function readStream(streamPath: string): { text: string; tools: string[] } {
  if (!existsSync(streamPath)) return { text: "", tools: [] };
  let text = "";
  const tools: string[] = [];
  for (const line of readFileSync(streamPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: { message?: { content?: unknown } };
    try { ev = JSON.parse(line); } catch { continue; }
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") text += block.text + "\n";
      if (block.type === "tool_use" && typeof block.name === "string") tools.push(block.name);
      if (block.type === "tool_result") {
        if (typeof block.content === "string") text += "[tool_result] " + block.content + "\n";
        else if (Array.isArray(block.content))
          for (const c of block.content as Array<Record<string, unknown>>)
            if (c.type === "text" && typeof c.text === "string") text += "[tool_result] " + c.text + "\n";
      }
    }
  }
  return { text, tools };
}
