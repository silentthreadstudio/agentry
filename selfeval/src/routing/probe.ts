// The probe driver (T-5 / ADR-004) — the integration finisher that SEQUENCES the pure pieces into the gated
// control flow the Spec demands. It does the volatile I/O at the edge (prepareSandbox + the injected Runner)
// and calls the pure core (extractShape, the three controls, the artifact builder) at the centre.
//
// THE CONTROL-FLOW ORDER IS THE AC8 CONTRACT (ADR-004) — enforced here, in this exact sequence:
//   (a) A/A unanimity   — run a designated A/A task EXACTLY k times; a split ⇒ instrument-measures-noise, STOP.
//   (b) positive control — a planted known-correct case; a miss ⇒ positive-control-missed, STOP.
//   (c) saturation guard — over the observed DISPATCHED shapes; runs BEFORE any accuracy computation; no
//                          spread ⇒ no-discriminating-power, STOP, emit NO accuracy number.
//   (d) ONLY THEN        — accuracy + confusion matrix + (when X is set) pass/fail.
// Each STOP returns an ABORTED artifact (the firing verdict, no score) — the AC8 "no number when a gate fires"
// guarantee made observable. The function NEVER reaches the accuracy computation if any gate failed.
//
// AC10: the only "what shape was chosen" input is `extractShape` over the conductor's WORK-FOLDER ARTIFACTS
// (autopilot-design §2). There is no task-completion / grade signal in selfeval to leak in — structurally
// enforced by the package boundary.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Runner, Sandbox } from "../io/port.ts";
import type { EvalObserver } from "../store/schema.ts";
import { prepareSandbox, seedSandbox } from "../io/sandbox.ts";
import { extractShape, DegenerateRunError } from "./extract.ts";
import { loadRoutingFixture, type RoutingTask } from "./fixture.ts";
import type { Shape } from "./shape.ts";
import { aaUnanimity, positiveControl, saturationGuard, DEFAULT_AA_REPEATS } from "./control.ts";
import {
  buildScoredArtifact,
  buildAbortedArtifact,
  writeArtifact,
  type RoutingArtifact,
  type RoutingOutcome,
  type TaskRuns,
} from "./artifact.ts";

/** The model the probe pins for every run. Discovered from env by the command; a generic default here. */
const DEFAULT_MODEL = "claude-opus-4-8[1m]";

/**
 * Mode directive appended to every live task (autopilot-design §1). Relying on the conductor to *detect* its
 * mode by running `printenv` proved unreliable (the model doesn't proactively self-check), so the harness
 * sets the mode explicitly. This sets the MODE only (autonomous, never block) — NOT the routing answer; the
 * shape decision (one-shot/spec-first/decompose) remains entirely the conductor's. The forcing clause makes
 * the decision OBSERVABLE: any escalation must leave a work-folder artifact.
 */
const AUTOPILOT_DIRECTIVE =
  "\n\n[AUTO-PILOT MODE — AGENTRY_AUTOPILOT=1]: Operate per the conducting skill's auto-pilot mode. Do NOT " +
  "block and do NOT call AskUserQuestion — there is no interactive user. For EVERY decision fork you would " +
  "otherwise ask about, decide the best option yourself with a stated rationale. CRITICAL: for ANY task that " +
  "escalates above a trivial one-shot (i.e. it hides a decision, spans multiple components, or needs a plan), " +
  "you MUST write the routing artifact to `.agentry/work/<slug>/` BEFORE building — a `spec.md` at minimum " +
  "(and `plan.md` + `tasks/` if you decompose) — recording each auto-decided fork + its assumption + a " +
  "one-line override hint. A genuinely trivial one-shot writes no work-folder artifact. Then proceed to build.";

/** Options for one probe run. The `Runner` is INJECTED (replay in tests = zero spend; live from the command). */
export interface RoutingProbeOptions {
  /** Directory holding `tasks.yaml` (the labeled set) — loaded via `loadRoutingFixture`. */
  fixtureDir: string;
  /** The runner to drive each task through — live (real `claude -p`) or replay (recorded streams). */
  runner: Runner;
  /** The A/A repeat count (OQ4 default 3). The designated A/A task runs EXACTLY this many times. */
  k?: number;
  /** Where the artifact JSON is written. */
  outPath: string;
  /** The success-condition threshold X (AC9b); unset by design (OQ5) ⇒ the artifact ships the "X unset" marker. */
  x?: number;
  /** Model id to pin per run (defaults to {@link DEFAULT_MODEL}); the command discovers it from env/config. */
  model?: string;
  /** Plugin root to load Agentry from (`--plugin-dir`); absent ⇒ the conductor layer is not loaded. */
  pluginDir?: string;
  /**
   * MULTI-RUN VARIANCE (default 1 = exactly today's single-run behavior). Routing is per-task stochastic, so a
   * single run is a noisy point estimate; running each labeled task `runs` times lets the artifact report a
   * per-run accuracy distribution + per-task stability instead of one number. When `runs === 1` the variance
   * fields are absent and the artifact is byte-for-byte today's shape. When `runs >= k`, the A/A control reuses
   * the first task's already-collected `runs` shapes (no extra A/A executions).
   */
  runs?: number;
  /**
   * ADDITIVE observability seam (ADR-002 / ADR-001). When absent (the default) the probe is byte-for-byte its
   * pre-seam behavior — every call site below is guarded `observer?.…?.()`, so a no-observer run neither emits
   * events nor captures sandboxes. The store injects this to drive `events.jsonl` + stdout progress and to copy
   * each task's sandbox out before it is discarded. The probe only ever WRITES through the sink, never reads it,
   * so it cannot influence any gated decision.
   */
  observer?: EvalObserver;
  /** The run id stamped onto emitted {@link EvalEvent}s (matches the store's `runs/<runId>/`); "" when unset. */
  runId?: string;
}

/** The result of a probe run: the emitted artifact + where it was written + the per-task outcomes it scored. */
export interface RoutingResult {
  /** The emitted artifact (aborted or scored). */
  artifact: RoutingArtifact;
  /** The path the artifact JSON was written to (the command echoes this to stdout). */
  outPath: string;
  /** The per-task outcomes (labeled floor + dispatched shape); empty insofar as a gate aborted before scoring. */
  outcomes: readonly RoutingOutcome[];
}

/** What one task run yields the caller: the routed shape (or null) PLUS the sandbox paths needed to capture it. */
interface RunOutcome {
  /** The ROUTED shape, or `null` for a degenerate / indeterminate no-artifact run (registered as a miss). */
  shape: Shape | null;
  /** The task's sandbox working dir — the capture source root (its `.agentry/work/` tree is copied out). */
  sandboxDir: string;
  /** Absolute path to this run's captured `stream.jsonl` under the sandbox. */
  streamPath: string;
}

/**
 * Run one routing task through the injected runner and extract its ROUTED shape from the conductor's
 * work-folder artifacts. Catches `DegenerateRunError` (an aborted / indeterminate no-artifact run) and reports
 * a `null` shape for that task rather than crashing the whole probe — one bad run must not sink the labeled set.
 *
 * Returns the sandbox dir + stream path alongside the shape (purely ADDITIVE — the extract/score logic is
 * unchanged) so the per-task loop can hand them to `observer?.onTaskComplete` before the sandbox is discarded.
 */
async function runAndExtract(
  task: RoutingTask,
  runner: Runner,
  model: string,
  pluginDir: string | undefined,
  fixtureDir: string,
): Promise<RunOutcome> {
  const sandbox: Sandbox = prepareSandbox();
  // Seed the working dir with this task's realistic starting codebase BEFORE the run, so the prompt's file
  // references resolve and multi-part tasks don't collapse to one-shot. Gated on the seed dir existing:
  // synthetic replay fixtures (no `seeds/<id>/`) are seeded with nothing and run unchanged.
  const seedDir = join(fixtureDir, "seeds", task.id);
  if (existsSync(seedDir)) {
    seedSandbox(sandbox.workingDir, seedDir);
  }
  const streamPath = join(sandbox.workingDir, "stream.jsonl");
  // Running "through Agentry" = invoking the front door so the conducting skill actually routes. When the
  // Agentry plugin is loaded (pluginDir set), wrap the bare labeled task as a `/agentry:go` invocation and
  // bypass perms so the conductor can dispatch headless inside the isolated sandbox. Without pluginDir
  // (e.g. replay tests), pass the bare prompt unchanged — the recorded stream already encodes the routing.
  const prompt = pluginDir !== undefined ? `/agentry:go ${task.prompt}${AUTOPILOT_DIRECTIVE}` : task.prompt;
  // ARTIFACT-AWARE early-terminate (autopilot-design §3): do NOT kill on the first dispatch — instead poll the
  // work folder and terminate the moment the routing shape is DETERMINED (plan/tasks ⇒ decompose; spec-only
  // past a grace ⇒ spec-first), with `timeoutMs` as the hard-ceiling fallback. This both reads the shape more
  // accurately (no slow roll mis-killed as one-shot before it writes) AND never builds the feature. It
  // supersedes the old `noKillOnDispatch` capped mode for live routing runs. The shape itself is still read by
  // `extractShape` AFTER the run from the same work folder — this only changes WHEN the child is stopped.
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
  try {
    // The shape is read from the conductor's WORK-FOLDER ARTIFACTS under the sandbox working dir (§2), with the
    // settle signals only disambiguating the no-artifact one-shot-vs-degenerate case.
    const shape = extractShape(sandbox.workingDir, {
      ...(result.resultSubtype !== undefined ? { resultSubtype: result.resultSubtype } : {}),
      producedTreeNonEmpty: result.producedTreeNonEmpty,
    });
    return { shape, sandboxDir: sandbox.workingDir, streamPath };
  } catch (err) {
    // indeterminate run — registered as a miss (null shape), not a crash; still report the sandbox for capture.
    if (err instanceof DegenerateRunError) return { shape: null, sandboxDir: sandbox.workingDir, streamPath };
    throw err;
  }
}

/**
 * Drive the routing probe end-to-end in the GATED order (ADR-004), writing the artifact to `opts.outPath`.
 *
 * Flow:
 *   1. load the labeled set (`loadRoutingFixture`);
 *   2. run each labeled task `runs` times (default 1) → its dispatched shapes (a degenerate repeat ⇒ null). The
 *          legacy single-shape outcomes use RUN 0; with `runs > 1` the full per-task shape set feeds the
 *          additive variance readouts (per-run accuracy distribution + per-task stability table);
 *   3. (a) A/A unanimity: the designated A/A task is the first labeled task. When `runs >= k`, REUSE its first
 *          `k` already-collected shapes (no extra A/A runs); otherwise run it EXACTLY `k` times. A split ⇒
 *          ABORT with `instrument-measures-noise`, no score;
 *   4. (b) positive control: the planted case is the first labeled task — its labeled floor is the hard-coded
 *          known-correct shape, compared to what it actually dispatched; a miss ⇒ ABORT, no score;
 *   5. (c) saturation guard over the OBSERVED dispatched shapes — RUNS BEFORE ANY ACCURACY — no spread ⇒ ABORT
 *          with `no-discriminating-power`, no score;
 *   6. (d) ONLY THEN: accuracy + confusion matrix + (X set) pass/fail.
 *
 * Any abort short-circuits BEFORE step 6 — the accuracy computation is unreachable once a gate fails.
 */
export async function runRoutingProbe(opts: RoutingProbeOptions): Promise<RoutingResult> {
  const k = opts.k ?? DEFAULT_AA_REPEATS;
  const runs = opts.runs ?? 1;
  const model = opts.model ?? DEFAULT_MODEL;
  const threshold = opts.x ?? null;
  const tasks = loadRoutingFixture(join(opts.fixtureDir, "tasks.yaml"));
  // ADDITIVE observability (default-absent): the observer + run id drive `events.jsonl`/stdout progress and the
  // per-task sandbox capture. Both hooks are optional, so a run without an observer behaves exactly as before.
  const observer = opts.observer;
  const runId = opts.runId ?? "";
  const N = tasks.length;

  // Step 2 — the labeled run: each task `runs` times → its dispatched shapes (a degenerate repeat ⇒ null).
  // The legacy single-shape `outcomes` (the existing accuracy/matrix/over-under inputs) use RUN 0's shape, so
  // when `runs === 1` this is byte-for-byte today's behavior. `taskRuns` carries all `runs` shapes per task for
  // the additive variance readouts.
  const taskRuns: TaskRuns[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const shapes: (Shape | null)[] = [];
    for (let r = 0; r < runs; r++) {
      // ADDITIVE: announce the task start, time the run (wall-clock), run it, then announce done + capture the
      // sandbox. All three observer calls are guarded — absent ⇒ no events, no capture, identical control flow.
      observer?.emit?.({
        kind: "task-started",
        runId,
        detail: `${i + 1}/${N} ${task.id}`,
        ts: new Date().toISOString(),
      });
      const startedMs = Date.now();
      const outcome = await runAndExtract(task, opts.runner, model, opts.pluginDir, opts.fixtureDir);
      const timingMs = Date.now() - startedMs;
      shapes.push(outcome.shape);
      const shapeLabel = outcome.shape ?? "degenerate";
      observer?.emit?.({
        kind: "task-done",
        runId,
        detail: `${i + 1}/${N} ${task.id} → ${shapeLabel} (${timingMs}ms)`,
        ts: new Date().toISOString(),
      });
      observer?.onTaskComplete?.({
        taskId: task.id,
        ...(runs > 1 ? { runIndex: r } : {}),
        sandboxDir: outcome.sandboxDir,
        streamPath: outcome.streamPath,
        shape: shapeLabel,
        timingMs,
      });
    }
    taskRuns.push({
      taskId: task.id,
      mustEscalate: task.trap === "must-escalate",
      labeledFloor: task.correctFloor,
      shapes,
    });
  }
  const outcomes: RoutingOutcome[] = taskRuns.map((t) => ({
    taskId: t.taskId,
    mustEscalate: t.mustEscalate,
    labeledFloor: t.labeledFloor,
    dispatched: t.shapes[0]!, // run 0 is the representative single-run shape (preserves runs===1 behavior)
  }));

  // --- the gated control ladder (ADR-004) — each gate aborts BEFORE the next, and all before scoring ----

  // (a) A/A unanimity — needs EXACTLY k dispatched shapes of the designated A/A task (the first labeled task).
  // REUSE: when `runs >= k`, the first task was ALREADY run `runs` times above, so slice its first k collected
  // shapes instead of executing k more A/A runs (saves compute — Spec §6). When `runs < k` (the runs===1 path),
  // fall back to the original separate A/A pass so today's exact behavior is preserved.
  const aaTask = tasks[0]!;
  let aaSourceShapes: (Shape | null)[];
  if (runs >= k) {
    aaSourceShapes = taskRuns[0]!.shapes.slice(0, k);
  } else {
    aaSourceShapes = [];
    for (let i = 0; i < k; i++) {
      const aaOutcome = await runAndExtract(aaTask, opts.runner, model, opts.pluginDir, opts.fixtureDir);
      aaSourceShapes.push(aaOutcome.shape);
    }
  }
  // A degenerate A/A repeat is non-comparable; record a sentinel so the set is not unanimous (it fails — a run
  // that can't even produce k clean repeats has not established the null).
  const aaShapes: Shape[] = aaSourceShapes.map((s) => s ?? ("__degenerate__" as Shape));
  const aa = aaUnanimity(aaShapes, k);
  if (!aa.ok) {
    emitGate(observer, runId, aa.verdict!);
    return emit(opts.outPath, buildAbortedArtifact(aa.verdict!), []);
  }

  // (b) positive control — the planted case is the first labeled task: its labeled floor is the known-correct
  // shape, checked against what it actually dispatched. A degenerate dispatch can never match ⇒ miss.
  const plantedTask = tasks[0]!;
  const plantedOutcome = outcomes.find((o) => o.taskId === plantedTask.id)!;
  const observedForPlanted = plantedOutcome.dispatched ?? ("__degenerate__" as Shape);
  const positive = positiveControl(plantedTask.correctFloor, observedForPlanted);
  if (!positive.ok) {
    emitGate(observer, runId, positive.verdict!);
    return emit(opts.outPath, buildAbortedArtifact(positive.verdict!), []);
  }

  // (c) saturation guard — over the OBSERVED dispatched shapes; MUST run before any accuracy computation.
  const observedShapes = outcomes
    .map((o) => o.dispatched)
    .filter((s): s is Shape => s !== null);
  const saturation = saturationGuard(observedShapes);
  if (!saturation.power) {
    // NO accuracy number is built — the aborted artifact carries the verdict only (AC8).
    emitGate(observer, runId, saturation.verdict!);
    return emit(opts.outPath, buildAbortedArtifact(saturation.verdict!), []);
  }

  // (d) ONLY NOW — accuracy + confusion matrix + (X set) pass/fail, plus the additive multi-run variance
  // (attached by the builder only when `runs > 1`; absent for the single-run backward-compatible artifact).
  const artifact = buildScoredArtifact(outcomes, threshold, taskRuns);
  return emit(opts.outPath, artifact, outcomes);
}

/** Write the artifact and package the result (single exit point keeps the write in one place). */
function emit(outPath: string, artifact: RoutingArtifact, outcomes: readonly RoutingOutcome[]): RoutingResult {
  writeArtifact(outPath, artifact);
  return { artifact, outPath, outcomes };
}

/** ADDITIVE: announce a fired control gate through the (optional) observer. No-op when no observer is injected. */
function emitGate(observer: EvalObserver | undefined, runId: string, verdict: string): void {
  observer?.emit?.({ kind: "gate-fired", runId, detail: verdict, ts: new Date().toISOString() });
}
