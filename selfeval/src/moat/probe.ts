// The moat (memory-hygiene) probe — drives the dimension end-to-end in the GATED order, mirroring the routing
// probe. Per task it runs TWO warm conductor runs in fresh sandboxes: one with a fork-resolving RELEVANT fact
// seeded, one with an irrelevant DECOY. It extracts each run's routed shape (the routing extractor, over the work
// folder) and whether recall LANDED the seed (the recall detector), then gates: seed-landing (validity) and
// decoy discrimination (power). Only if both pass does it score the compound rate.
//
// The `Runner` is INJECTED (live `claude -p` from the command; a replay runner in tests = zero spend). The probe
// owns the gated flow + the per-run orchestration; the pure scoring/gates live in artifact.ts / control.ts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Runner, Sandbox } from "../io/port.ts";
import { liveRunner } from "../io/live.ts";
import { prepareSandbox, seedSandbox } from "../io/sandbox.ts";
import { extractShape, DegenerateRunError } from "../routing/extract.ts";
import type { Shape } from "../routing/shape.ts";
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
 * (the compounding behavior under test). Sets only the MODE — the routing decision stays the conductor's.
 */
const MOAT_DIRECTIVE =
  "\n\n[AUTO-PILOT MODE — AGENTRY_AUTOPILOT=1]: Operate per the conducting skill's auto-pilot mode. Do NOT block " +
  "and do NOT call AskUserQuestion. FIRST, before routing, prime memory: call memory_resync, then memory_recall " +
  "for this task. If recalled precedent DECIDES a fork this task would otherwise hide, APPLY that decision and " +
  "cite it — a fork already settled by durable memory is NO LONGER undecided, so do not escalate on its account. " +
  "For any genuine remaining escalation above a trivial one-shot, write the routing artifact to " +
  "`.agentry/work/<slug>/` (spec.md at minimum) before building. A settled/trivial one-shot writes no artifact.";

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
}

/** The result of a moat probe run: the emitted artifact, where it was written, and the per-task outcomes. */
export interface MoatResult {
  artifact: MoatArtifact;
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
): Promise<WarmOutcome> {
  const sandbox: Sandbox = prepareSandbox();
  const seedDir = join(fixtureDir, "seeds", task.id);
  if (existsSync(seedDir)) seedSandbox(sandbox.workingDir, seedDir);
  // Seed the fact into the conductor's actual project-memory root (the workingDir under `claude -p`).
  seedFact(sandbox.workingDir, fact, idSeed);

  const streamPath = join(sandbox.workingDir, "stream.jsonl");
  const prompt = pluginDir !== undefined ? `/agentry:go ${task.prompt}${MOAT_DIRECTIVE}` : task.prompt;
  const result = await runner.run(
    {
      prompt,
      model,
      streamPath,
      terminateOnArtifact: true,
      ...(pluginDir !== undefined ? { pluginDir, permissionMode: "bypassPermissions" } : {}),
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
  const landed =
    recallLanded(text, recallFired) &&
    (task.factSignature !== undefined ? factSurfaced(text, task.factSignature) : true);

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
  const runId = opts.runId ?? "";
  const emit = (detail: string): void =>
    opts.observer?.emit?.({ kind: "task-done", runId, detail, ts: new Date().toISOString() });

  const outcomes: MoatOutcome[] = [];
  let i = 0;
  for (const task of tasks) {
    i++;
    opts.observer?.emit?.({ kind: "task-started", runId, detail: `${i}/${tasks.length} ${task.id}`, ts: new Date().toISOString() });
    // Two warm runs per task: distinct id-seeds keep the two seeded facts' ULIDs from colliding.
    const relevant = await runWarm(task, task.relevant, 2 * i, opts.runner, model, opts.pluginDir, opts.fixtureDir);
    const decoy = await runWarm(task, task.decoy, 2 * i + 1, opts.runner, model, opts.pluginDir, opts.fixtureDir);

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
    const artifact = buildAbortedArtifact(landing.verdict!);
    return { artifact, outPath: writeArtifact(opts.outPath, artifact), outcomes };
  }

  // GATE 2 — power: the relevant fact must compound where the decoy does not.
  const rows = outcomes.map(censusRow);
  const disc = discriminationGuard(rows.map((r) => r.compounded), rows.map((r) => !r.decoyHeld));
  if (!disc.power) {
    opts.observer?.emit?.({ kind: "gate-fired", runId, detail: `discrimination failed: ${disc.verdict}`, ts: new Date().toISOString() });
    const artifact = buildAbortedArtifact(disc.verdict!);
    return { artifact, outPath: writeArtifact(opts.outPath, artifact), outcomes };
  }

  const artifact = buildScoredArtifact(outcomes);
  return { artifact, outPath: writeArtifact(opts.outPath, artifact), outcomes };
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
