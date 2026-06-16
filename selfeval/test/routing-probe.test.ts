// Tests for the probe driver + artifact emitter + headless command (T-5 / AC3, AC4, AC8, AC9a/b, AC10).
// ZERO API spend: every case drives the probe through the REAL `replaySequenceRunner` over recorded
// `RunResult` fixtures (one per `runner.run()` call). Each recorded result carries the WORK-FOLDER ARTIFACT
// layout its shape implies (autopilot-design §2); the replay runner plants those under the sandbox's
// `.agentry/work/*`, so the probe runs the genuine artifact-based extract→control→score path offline. The
// forced cases (a collapsed shape set, an A/A split) prove the GATED ORDER (ADR-004): a fired gate aborts
// BEFORE scoring and emits NO accuracy number.
//
// DECOUPLED FROM THE PRODUCT SET: these tests load a SMALL, STABLE synthetic fixture they own
// (`test/fixtures/routing-mini/tasks.yaml`) — NOT the real `fixtures/routing/tasks.yaml`, which grows over time.
// Every count/accuracy assertion is derived from the loaded mini fixture (N, the per-index floors, the task
// ids), never a hard-coded number from the real set — so growing the product set can never break these tests.
//
// HOW SHAPES ARE INJECTED: the probe reads the routed shape from `extractShape` over WORK-FOLDER ARTIFACTS, so a
// recorded `RunResult` ENCODES its shape via `workFolder` (a planted `plan.md` ⇒ decompose, `spec.md` ⇒
// spec-first) or via a clean one-shot settle with no work folder. `runResultFor(shape)` builds that result; each
// `runner.run()` call consumes the next recorded result in sequence order.
//
// HOW THE A/A k-REPEATS ARE SOURCED (single-run path): `runRoutingProbe` runs the labeled set once each
// (N calls), THEN runs the designated A/A task (the FIRST labeled task) EXACTLY k more times (k calls). So a
// replay sequence is [ ...N task results, ...k A/A results ]. The tests build that sequence explicitly; the A/A
// tail is the last k entries — k identical results there proves unanimity, a split there proves the noise verdict.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { replaySequenceRunner } from "../src/io/replay.ts";
import type { RunResult } from "../src/io/port.ts";
import { runRoutingProbe } from "../src/routing/probe.ts";
import { loadRoutingFixture } from "../src/routing/fixture.ts";
import type { Shape } from "../src/routing/shape.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// The probe's `fixtureDir` — it loads `<dir>/tasks.yaml`. The MINI fixture, owned by these tests, not the real set.
const MINI_FIXTURE_DIR = join(HERE, "fixtures", "routing-mini");

type ShapeName = "one-shot" | "spec-first" | "decompose";

// --- Derive everything from the loaded mini fixture (count-agnostic) -----------------------------------
//
// Load the mini set ONCE and read N + the per-index floors + the task ids from it. Every expectation below is
// computed against these — there is no `3/7`, `6/7`, or real-set task name anywhere in this file.
const MINI_TASKS = loadRoutingFixture(join(MINI_FIXTURE_DIR, "tasks.yaml"));
const N = MINI_TASKS.length;
const FLOORS: readonly Shape[] = MINI_TASKS.map((t) => t.correctFloor);
const TASK_IDS: readonly string[] = MINI_TASKS.map((t) => t.id);
const ESCALATION_IDS: readonly string[] = MINI_TASKS.filter((t) => t.trap === "must-escalate").map((t) => t.id);
const K = 3;

// The first task is the probe's A/A + positive-control anchor; its floor is the planted known-correct shape.
const AA_FLOOR = FLOORS[0]!;
const AA_TASK_ID = TASK_IDS[0]!;

// Sanity guards on the fixture's invariants the tests rely on (a drift in the mini fixture fails loudly HERE,
// not as an inscrutable assertion later). These are about the fixture's SHAPE, not its size.
assert.ok(N >= 4, "mini fixture covers enough tasks to exercise the matrix");
assert.equal(AA_FLOOR, "one-shot", "task[0] floor is one-shot (the A/A + positive-control anchor)");
assert.ok(new Set(FLOORS).size >= 2, "the mini fixture spans ≥2 shapes so saturation has spread");
assert.ok(ESCALATION_IDS.length >= 1, "the mini fixture has ≥1 must-escalate trap");

/** The accuracy the artifact must report for a single-run dispatch of `shapes` against the mini floors. */
function expectedAccuracy(shapes: readonly ShapeName[]): number {
  const correct = shapes.filter((s, i) => s === FLOORS[i]).length;
  return correct / N;
}

/** Per-task shapes that route EVERY task to its own labeled floor ⇒ a fully-correct, fully-spread baseline. */
function allCorrectShapes(): ShapeName[] {
  return FLOORS.map((f) => f as ShapeName);
}

/**
 * A recorded RunResult whose work-folder artifacts encode the given shape (autopilot-design §2):
 *   - decompose  → a `plan.md` planted in a work folder;
 *   - spec-first → a `spec.md` only;
 *   - one-shot   → no work-folder artifacts, with a clean settle (success) + a non-empty produced tree.
 * The replay runner materializes `workFolder` under the sandbox before the probe's `extractShape` scans it.
 * `streamPath` is required by the type but no longer the shape input (kept for provenance).
 */
function runResultFor(shape: ShapeName): RunResult {
  if (shape === "decompose") {
    return {
      streamPath: "unused.jsonl",
      producedTreeNonEmpty: true,
      workFolder: { "work/probe-case/plan.md": "# plan\n" },
    };
  }
  if (shape === "spec-first") {
    return {
      streamPath: "unused.jsonl",
      producedTreeNonEmpty: true,
      workFolder: { "work/probe-case/spec.md": "# spec\n" },
    };
  }
  // one-shot: no work-folder artifacts; the settle signals carry the one-shot verdict.
  return { streamPath: "unused.jsonl", resultSubtype: "success", producedTreeNonEmpty: true };
}

/** Write a sequence of RunResults to temp JSON files and return a real `replaySequenceRunner` over them. */
function sequenceRunner(results: readonly RunResult[]) {
  const dir = mkdtempSync(join(tmpdir(), "selfeval-probe-fixtures-"));
  const paths = results.map((r, i) => {
    const p = join(dir, `run-${i}.json`);
    writeFileSync(p, JSON.stringify(r), "utf8");
    return p;
  });
  return replaySequenceRunner(paths);
}

/** A fresh temp path for the artifact each test writes. */
function outPath(): string {
  return join(mkdtempSync(join(tmpdir(), "selfeval-probe-out-")), "routing-accuracy.json");
}

/**
 * Build the full single-run replay sequence for a probe run: N labeled-run results followed by k A/A-tail
 * results. `labeledShapes` maps each of the N tasks (in fixture order) to the shape its recorded run dispatches.
 */
function fullSequence(
  labeledShapes: readonly ShapeName[],
  aaShape: ShapeName,
  k = K,
): RunResult[] {
  assert.equal(labeledShapes.length, N, "labeledShapes must cover every task");
  const labeled = labeledShapes.map((s) => runResultFor(s));
  const aaTail = Array.from({ length: k }, () => runResultFor(aaShape));
  return [...labeled, ...aaTail];
}

// --- AC3 / AC4: a mixed-shape fixture produces a scored artifact ---------------------------------------

test("mixed-shape run => scored artifact with accuracy, confusion matrix, over/under-routes, early-signal caveat", async () => {
  // Start from the fully-correct baseline (every task → its floor), then DEVIATE a couple deterministically so
  // over- and under-routes appear. The A/A anchor (task[0], floor one-shot) is kept correct so the positive
  // control passes and the A/A tail is unanimous.
  const labeled = allCorrectShapes();
  // Pick the first non-anchor one-shot floor and OVER-route it (one-shot floor → decompose).
  const overIdx = FLOORS.findIndex((f, i) => i !== 0 && f === "one-shot");
  // Pick the must-escalate trap and UNDER-route it (its floor ≥ spec-first → one-shot).
  const underIdx = TASK_IDS.indexOf(ESCALATION_IDS[0]!);
  assert.ok(overIdx >= 0, "fixture has a non-anchor one-shot to over-route");
  assert.ok(underIdx >= 0, "fixture has a must-escalate trap to under-route");
  labeled[overIdx] = "decompose";
  labeled[underIdx] = "one-shot";

  const runner = sequenceRunner(fullSequence(labeled, "one-shot"));
  const out = outPath();

  const result = await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: out, k: K });

  assert.equal(result.artifact.condition, "scored");
  assert.equal(typeof result.artifact.accuracy, "number");
  // Accuracy is DERIVED from the injected shapes vs the mini floors — not a literal.
  assert.equal(result.artifact.accuracy, expectedAccuracy(labeled));
  assert.ok(result.artifact.confusionMatrix && result.artifact.confusionMatrix.length > 0, "matrix populated");
  assert.ok(
    result.artifact.overRoutes!.some((r) => r.taskId === TASK_IDS[overIdx]),
    "over-route readable",
  );
  assert.ok(
    result.artifact.underRoutes!.some((r) => r.taskId === TASK_IDS[underIdx]),
    "under-route readable",
  );
  assert.match(result.artifact.earlySignalCaveat, /Early-signal/);

  // AC10: the artifact written to disk matches the returned one (the only score input was the dispatched shape).
  const onDisk = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(onDisk.accuracy, expectedAccuracy(labeled));
  assert.equal(onDisk.condition, "scored");
});

// --- AC8: a collapsed dispatch set aborts at saturation, BEFORE scoring --------------------------------

test("collapsed-shape run => saturationGuard aborts, NO accuracy emitted, abort precedes scoring", async () => {
  // Everything dispatches to the A/A floor (so positive control + A/A both pass first), leaving saturation as the
  // gate that must fire. No spread => no-discriminating-power, no score.
  const labeled = Array.from({ length: N }, () => AA_FLOOR as ShapeName);
  const runner = sequenceRunner(fullSequence(labeled, AA_FLOOR as ShapeName));
  const out = outPath();

  const result = await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: out, k: K });

  assert.equal(result.artifact.condition, "aborted");
  assert.equal(result.artifact.abortVerdict, "no-discriminating-power");
  // The proof scoring did not run: accuracy is null and NO matrix / over-under / pass-fail was produced.
  assert.equal(result.artifact.accuracy, null);
  assert.equal(result.artifact.confusionMatrix, undefined);
  assert.equal(result.artifact.overRoutes, undefined);
  assert.equal(result.artifact.passFail, undefined);

  const onDisk = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(onDisk.accuracy, null);
  assert.equal(onDisk.abortVerdict, "no-discriminating-power");
  assert.equal("confusionMatrix" in onDisk, false, "no matrix field is serialized when a gate aborted");
});

// --- AC6: A/A unanimity vs a split --------------------------------------------------------------------

test("A/A: k identical A/A-tail shapes => unanimity ok, the run proceeds to score", async () => {
  // A spread labeled run (so saturation passes) with a unanimous A/A tail (all the A/A floor, matching task[0]).
  const runner = sequenceRunner(fullSequence(allCorrectShapes(), AA_FLOOR as ShapeName));
  const result = await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: outPath(), k: K });

  // Unanimity held (and saturation/positive passed) => the run reached scoring, not an abort.
  assert.equal(result.artifact.condition, "scored");
});

test("A/A: a split in the A/A tail => instrument-measures-noise verdict, NO score", async () => {
  // Labeled run spreads (saturation would pass) but the A/A tail is NOT unanimous => the run must abort at A/A,
  // before saturation or scoring. Build the tail by hand: k entries, the last one different from the rest.
  const labeledResults = allCorrectShapes().map((s) => runResultFor(s));
  // A non-unanimous tail: (k-1) at the A/A floor + 1 deviating shape. Pick a different shape than the floor.
  const otherShape: ShapeName = AA_FLOOR === "one-shot" ? "spec-first" : "one-shot";
  const splitTail = [
    ...Array.from({ length: K - 1 }, () => runResultFor(AA_FLOOR as ShapeName)),
    runResultFor(otherShape),
  ];
  const runner = sequenceRunner([...labeledResults, ...splitTail]);

  const result = await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: outPath(), k: K });

  assert.equal(result.artifact.condition, "aborted");
  assert.equal(result.artifact.abortVerdict, "instrument-measures-noise");
  assert.equal(result.artifact.accuracy, null);
});

// --- AC7: a planted positive-control miss aborts loudly -----------------------------------------------

test("positive control: task[0] dispatched off its planted floor => positive-control-missed, NO score", async () => {
  // task[0]'s floor is the A/A floor; dispatch it OFF that floor so the planted positive control misses. The A/A
  // tail is built unanimous-but-wrong (all the same off-floor shape) so A/A unanimity HOLDS and the FIRST gate to
  // fail is the positive control. Verify it aborts there with the plumbing verdict.
  const offFloor: ShapeName = AA_FLOOR === "one-shot" ? "decompose" : "one-shot";
  const labeled = allCorrectShapes();
  labeled[0] = offFloor; // the anchor task dispatches off its planted floor
  const runner = sequenceRunner(fullSequence(labeled, offFloor));
  const result = await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: outPath(), k: K });

  assert.equal(result.artifact.condition, "aborted");
  assert.equal(result.artifact.abortVerdict, "positive-control-missed");
  assert.equal(result.artifact.accuracy, null);
});

// --- AC9a / AC9b: the success condition with and without a threshold X ---------------------------------

test("with X provided => the condition + a computed pass/fail appear", async () => {
  const runner = sequenceRunner(fullSequence(allCorrectShapes(), AA_FLOOR as ShapeName));
  const result = await runRoutingProbe({
    fixtureDir: MINI_FIXTURE_DIR,
    runner,
    outPath: outPath(),
    k: K,
    x: 0.5,
  });

  assert.equal(result.artifact.condition, "scored");
  assert.ok(result.artifact.successCondition, "condition present");
  assert.equal(result.artifact.successCondition!.threshold, 0.5);
  assert.equal(result.artifact.successCondition!.xUnsetMarker, undefined, "no unset marker when X is set");
  assert.ok(result.artifact.passFail, "pass/fail computed when X is set");
  assert.equal(typeof result.artifact.passFail!.pass, "boolean");
  assert.equal(typeof result.artifact.passFail!.accuracyPass, "boolean");
  assert.equal(typeof result.artifact.passFail!.zeroTrapUnderroute, "boolean");
  // The all-correct baseline scores 1.0 ⇒ accuracy ≥ 0.5 and the trap was escalated ⇒ a clean pass.
  assert.equal(result.artifact.accuracy, 1);
  assert.equal(result.artifact.passFail!.pass, true);
});

test("without X => the success condition carries the 'X unset' marker and NO pass/fail", async () => {
  const runner = sequenceRunner(fullSequence(allCorrectShapes(), AA_FLOOR as ShapeName));
  const result = await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: outPath(), k: K });

  assert.equal(result.artifact.condition, "scored");
  assert.ok(result.artifact.successCondition, "condition present even with X unset");
  assert.equal(result.artifact.successCondition!.threshold, null);
  assert.match(result.artifact.successCondition!.xUnsetMarker ?? "", /X unset/);
  assert.equal(result.artifact.passFail, undefined, "no pass/fail until X is set");
});

// --- MULTI-RUN VARIANCE: per-task stability + per-run accuracy distribution ----------------------------
//
// In the multi-run path (`runs >= k`) the A/A control REUSES task[0]'s first k collected shapes, so there is
// NO separate A/A tail: the replay sequence is exactly N*runs results in TASK-MAJOR order
// (task0 run0, task0 run1, …, task0 run(runs-1), task1 run0, …). `multiRunSequence` builds that layout from a
// per-task list of per-run shapes.

/** Build the task-major replay sequence for a multi-run probe: `perTaskShapes[t][r]` = task t's run-r shape. */
function multiRunSequence(perTaskShapes: readonly (readonly ShapeName[])[]): RunResult[] {
  assert.equal(perTaskShapes.length, N, "perTaskShapes must cover every task");
  const seq: RunResult[] = [];
  for (const taskShapes of perTaskShapes) {
    for (const s of taskShapes) seq.push(runResultFor(s));
  }
  return seq;
}

/** Per-task shapes that route every task to its floor on every run ⇒ a fully-stable, fully-correct multi-run set. */
function stableRuns(runs: number): ShapeName[][] {
  return FLOORS.map((f) => Array.from({ length: runs }, () => f as ShapeName));
}

test("runs=3: a task whose runs disagree => stability < 1 and it is listed in noisyTasks", async () => {
  // Start fully-stable + fully-correct (task[0] routes its floor every run ⇒ unanimous A/A reuse + positive
  // control pass), then make the LAST task noisy: its 3 runs are [floor, otherShape, floor] — mode = floor (2/3),
  // correctFraction = 2/3. Every other task stays stable so saturation passes and the rest of the table is clean.
  const runs = 3;
  const perTask = stableRuns(runs);
  const noisyIdx = N - 1;
  const noisyFloor = FLOORS[noisyIdx]! as ShapeName;
  const noisyOther: ShapeName = noisyFloor === "decompose" ? "spec-first" : "decompose";
  perTask[noisyIdx] = [noisyFloor, noisyOther, noisyFloor];

  const runner = sequenceRunner(multiRunSequence(perTask));
  const result = await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: outPath(), k: K, runs });

  assert.equal(result.artifact.condition, "scored");

  // Per-task stability row for the noisy task — derived expectations (2 of 3 runs at the modal/floor shape).
  const noisyId = TASK_IDS[noisyIdx]!;
  const noisy = result.artifact.stabilityTable!.find((t) => t.taskId === noisyId)!;
  assert.equal(noisy.modalShape, noisyFloor, "mode is the 2-of-3 shape (the floor)");
  assert.equal(noisy.stability, 2 / 3, "stability = fraction equal to the mode");
  assert.equal(noisy.correctFraction, 2 / 3, "correctFraction = fraction equal to the labeled floor");

  // The noisy task surfaces in noisyTasks; the stable anchor does not.
  assert.ok(result.artifact.noisyTasks!.includes(noisyId), "noisy task listed");
  assert.ok(!result.artifact.noisyTasks!.includes(AA_TASK_ID), "stable anchor not listed");

  // Per-run accuracy distribution across the 3 runs, DERIVED per run index from perTask vs FLOORS.
  //   run i accuracy = #(task t's run-i shape == FLOORS[t]) / N.
  const perRunExpected = Array.from({ length: runs }, (_, i) =>
    expectedAccuracy(perTask.map((shapes) => shapes[i]!)),
  );
  const dist = result.artifact.accuracyDistribution!;
  assert.equal(dist.runs, runs);
  assert.deepEqual(dist.perRunAccuracy, perRunExpected);
  assert.equal(dist.accuracyMean, perRunExpected.reduce((a, b) => a + b, 0) / runs);
  assert.equal(dist.accuracyMin, Math.min(...perRunExpected));
  assert.equal(dist.accuracyMax, Math.max(...perRunExpected));
  assert.ok(dist.accuracyStd > 0, "non-zero std when runs disagree");
  // expectedAccuracy = mean over tasks of correctFraction: every task is 1.0 except the noisy one at 2/3.
  assert.equal(dist.expectedAccuracy, ((N - 1) * 1 + 2 / 3) / N);
});

test("runs=3: a fully-stable set => empty noisyTasks and accuracyStd 0", async () => {
  // Every task routes its floor on all 3 runs => every stability is 1.0, every per-run accuracy is identical (and
  // equal to 1.0), so std is exactly 0 and noisyTasks is empty. The set still spans shapes so saturation passes.
  const runner = sequenceRunner(multiRunSequence(stableRuns(3)));
  const result = await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: outPath(), k: K, runs: 3 });

  assert.equal(result.artifact.condition, "scored");
  assert.deepEqual(result.artifact.noisyTasks, [], "no noisy tasks when every task is stable");
  assert.equal(result.artifact.accuracyDistribution!.accuracyStd, 0, "std is 0 when every run scores the same");
  // Every per-task stability is 1.0.
  assert.ok(result.artifact.stabilityTable!.every((t) => t.stability === 1), "all tasks fully stable");
});

test("runs=1: the variance fields are ABSENT (artifact is byte-for-byte today's single-run shape)", async () => {
  // Backward-compat clause: with the default single run, no variance fields are attached.
  const runner = sequenceRunner(fullSequence(allCorrectShapes(), AA_FLOOR as ShapeName));
  const result = await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: outPath(), k: K });

  assert.equal(result.artifact.condition, "scored");
  assert.equal(result.artifact.accuracyDistribution, undefined, "no distribution on a single run");
  assert.equal(result.artifact.stabilityTable, undefined, "no stability table on a single run");
  assert.equal(result.artifact.noisyTasks, undefined, "no noisyTasks list on a single run");
});

// --- AC3 (headless): command.ts --runner replay exits 0, stdout = artifact path ------------------------

test("command.ts --runner replay --fixture <dir> exits 0 and stdout is the artifact path", async () => {
  const { main } = await import("../src/routing/command.ts");

  // Build a sequence of RunResult fixtures on disk and pass them via --replay-fixtures.
  const results = fullSequence(allCorrectShapes(), AA_FLOOR as ShapeName);
  const dir = mkdtempSync(join(tmpdir(), "selfeval-cmd-fixtures-"));
  const fixturePaths = results.map((r, i) => {
    const p = join(dir, `run-${i}.json`);
    writeFileSync(p, JSON.stringify(r), "utf8");
    return p;
  });
  const out = outPath();

  // Capture stdout to assert it carries ONLY the artifact path.
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  };

  let code: number;
  try {
    code = await main([
      "--fixture", MINI_FIXTURE_DIR,
      "--runner", "replay",
      "--replay-fixtures", fixturePaths.join(","),
      "--out", out,
      "--k", String(K),
    ]);
  } finally {
    (process.stdout.write as unknown) = originalWrite;
  }

  assert.equal(code, 0, "headless command exits 0");
  assert.equal(writes.join(""), `${out}\n`, "stdout is exactly the artifact path");
  // The artifact really landed on disk and is a scored result.
  const onDisk = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(onDisk.condition, "scored");
});
