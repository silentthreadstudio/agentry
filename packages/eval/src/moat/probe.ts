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
import { liveRunner } from "../io/live.ts";
import { prepareSandbox, seedSandbox } from "../io/sandbox.ts";
import { extractShape, DegenerateRunError } from "../conduct/extract.ts";
import { buildConductorPrompt } from "../conductor-prompt.ts";
import type { Shape } from "../conduct/shape.ts";
import type { EvalObserver } from "../store/schema.ts";

import { loadMoatFixture, type MoatTask } from "./fixture.ts";
import { seedFact, type FactSeed } from "./seed.ts";
import { recallLanded, factSurfaced } from "./recall.ts";
import { seedLandingGuard, discriminationGuard } from "./control.ts";
import {
  buildScoredArtifact, buildAbortedArtifact, writeArtifact, censusRow,
  type MoatArtifact, type MoatOutcome,
} from "./artifact.ts";

/** The model pinned per run (the command discovers it from env/config; a generic default here). */
const DEFAULT_MODEL = "claude-opus-4-8[1m]";

/**
 * The warm-run directive: prime memory FIRST, and let a recalled decision COLLAPSE a fork it already settled
 * (the compounding behavior under test). Sets only the MODE — the routing decision stays the conductor's. APPENDED
 * to the EXPANDED conductor prompt (`buildConductorPrompt`, which already supplies the auto-pilot framing), so this
 * carries ONLY the moat-specific memory-priming — not a second auto-pilot block.
 */
const MOAT_DIRECTIVE =
  "\n\n[MOAT — PRIME MEMORY FIRST]: Before routing, prime memory: call memory_resync, then memory_recall for this " +
  "task. If recalled precedent DECIDES a fork this task would otherwise hide, APPLY that decision and cite it — a " +
  "fork already settled by durable memory is NO LONGER undecided, so do not escalate on its account.";

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
  /** Where the artifact JSON is written. */
  outPath: string;
  /** Model id to pin per run (defaults to {@link DEFAULT_MODEL}). */
  model?: string;
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

/** What one warm run yields: the routed shape (or null), whether the seed landed, and the stream path (provenance). */
interface WarmOutcome {
  shape: Shape | null;
  landed: boolean;
  streamPath: string;
}

/**
 * Run ONE warm conductor run: fresh sandbox, seed the task's codebase + the given fact into the workingDir's
 * project memory (the root `claude -p` reads), route the task, and extract both the routed shape and whether
 * recall landed the seed. A degenerate run (no determinable shape) yields `shape: null` rather than crashing.
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
  // `signature` ties landing to a SPECIFIC fact (the relevant run). The decoy run passes no signature, so its
  // landing just means "recall fired + non-empty" — the correct meaning for an irrelevant seed it shouldn't apply.
  const landed =
    recallLanded(text, recallFired) &&
    (signature !== undefined ? factSurfaced(text, signature) : true);

  return { shape, landed, streamPath };
}

/**
 * Drive the moat probe end-to-end in the GATED order, writing the artifact to `opts.outPath`.
 *
 * Flow: per task → warm-relevant run + warm-decoy run → collect outcomes → seed-landing gate (every relevant run
 * must have recalled its seed) → discrimination gate (relevant compounds where the decoy does not) → score. A
 * gate failure aborts with the pinned verdict and NO compound number (mirrors routing's AC8 contract).
 */
export async function runMoatProbe(opts: MoatProbeOptions): Promise<MoatResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const tasks = loadMoatFixture(join(opts.fixtureDir, "tasks.yaml"));
  // The pre-registered moat target W is loaded up front — the falsifiable target MUST EXIST before the run.
  const target = loadMoatThreshold(opts.thresholdPath);
  const runId = opts.runId ?? "";
  const emit = (detail: string): void =>
    opts.observer?.emit?.({ kind: "task-done", runId, detail, ts: new Date().toISOString() });

  const outcomes: MoatOutcome[] = [];
  let i = 0;
  for (const task of tasks) {
    i++;
    opts.observer?.emit?.({ kind: "task-started", runId, detail: `${i}/${tasks.length} ${task.id}`, ts: new Date().toISOString() });
    // Two warm runs per task: distinct id-seeds keep the two seeded facts' ULIDs from colliding. Only the
    // relevant run gets the fact signature (landing must tie to THAT fact); the decoy's landing is "recalled non-empty".
    const relevant = await runWarm(task, task.relevant, 2 * i, opts.runner, model, opts.pluginDir, opts.fixtureDir, task.factSignature);
    const decoy = await runWarm(task, task.decoy, 2 * i + 1, opts.runner, model, opts.pluginDir, opts.fixtureDir, undefined);

    const outcome: MoatOutcome = {
      taskId: task.id,
      coldFloor: task.coldFloor,
      relevant: { shape: relevant.shape, landed: relevant.landed },
      decoy: { shape: decoy.shape, landed: decoy.landed },
    };
    outcomes.push(outcome);
    const row = censusRow(outcome);
    emit(`${i}/${tasks.length} ${task.id} → relevant ${relevant.shape ?? "—"} / decoy ${decoy.shape ?? "—"} (${row.compounded ? "compounded" : "held"})`);
  }

  // GATE 1 — validity: every relevant warm run must have landed its seed, or the measurement is invalid.
  const landing = seedLandingGuard(outcomes.map((o) => o.relevant.landed));
  if (!landing.ok) {
    opts.observer?.emit?.({ kind: "gate-fired", runId, detail: `seed-landing failed (${landing.landedCount}/${landing.total} landed)`, ts: new Date().toISOString() });
    // A gate fired ⇒ NO discrimination number, so `observed` is null and no pass/fail is computed — but the
    // pre-registered target still ships on the public path (the falsifiable form is always on record).
    return emitPublic(opts.outPath, buildAbortedArtifact(landing.verdict!), target, null, outcomes);
  }

  // GATE 2 — power: the relevant fact must compound where the decoy does not.
  const rows = outcomes.map(censusRow);
  const disc = discriminationGuard(rows.map((r) => r.compounded), rows.map((r) => !r.decoyHeld));
  if (!disc.power) {
    opts.observer?.emit?.({ kind: "gate-fired", runId, detail: `discrimination failed: ${disc.verdict}`, ts: new Date().toISOString() });
    return emitPublic(opts.outPath, buildAbortedArtifact(disc.verdict!), target, null, outcomes);
  }

  const artifact = buildScoredArtifact(outcomes);
  // Scored ⇒ the measured discrimination is the run's honest delta; pass/fail is computed against W only when W is
  // calibrated (the artifact reports the real number regardless of the target — never inflated by it).
  return emitPublic(opts.outPath, artifact, target, artifact.discrimination ?? null, outcomes);
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
