// Tests for the ADDITIVE observer seam threaded into the routing probe (T-D / AC2 / AC5). ZERO API spend: the
// probe is driven through the REAL `replaySequenceRunner` over recorded `RunResult` fixtures, exactly as
// `routing-probe.test.ts` does. The new surface is the optional `observer?: EvalObserver` on the probe options:
// a RECORDING observer (its `emit`/`onTaskComplete` push to arrays) proves the probe fires a task-started +
// task-done event per task run AND hands `onTaskComplete` the sandbox paths to capture — without touching any
// gated decision (the artifact is still scored identically).
//
// SHARED FIXTURE: the same owned mini fixture (`test/fixtures/routing-mini/tasks.yaml`) the routing-probe tests
// use, with every count/shape DERIVED from the loaded set (no real-set literal) so growing the product set can
// never break these tests.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { replaySequenceRunner } from "../src/io/replay.ts";
import type { RunResult } from "../src/io/port.ts";
import { runRoutingProbe } from "../src/routing/probe.ts";
import { loadRoutingFixture } from "../src/routing/fixture.ts";
import type { Shape } from "../src/routing/shape.ts";
import type { EvalEvent, EvalObserver, TaskCaptureSrc } from "../src/store/schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MINI_FIXTURE_DIR = join(HERE, "fixtures", "routing-mini");

type ShapeName = "one-shot" | "spec-first" | "decompose";

// Derive N + the per-index floors + ids from the loaded mini set (count-agnostic, mirrors routing-probe.test.ts).
const MINI_TASKS = loadRoutingFixture(join(MINI_FIXTURE_DIR, "tasks.yaml"));
const N = MINI_TASKS.length;
const FLOORS: readonly Shape[] = MINI_TASKS.map((t) => t.correctFloor);
const TASK_IDS: readonly string[] = MINI_TASKS.map((t) => t.id);
const AA_FLOOR = FLOORS[0]! as ShapeName;
const K = 3;

assert.ok(N >= 4, "mini fixture covers enough tasks");
assert.equal(AA_FLOOR, "one-shot", "task[0] floor is one-shot (the A/A + positive-control anchor)");

/** A recorded RunResult whose work-folder artifacts encode `shape` (same encoding as routing-probe.test.ts). */
function runResultFor(shape: ShapeName): RunResult {
  if (shape === "decompose") {
    return { streamPath: "unused.jsonl", producedTreeNonEmpty: true, workFolder: { "work/probe-case/plan.md": "# plan\n" } };
  }
  if (shape === "spec-first") {
    return { streamPath: "unused.jsonl", producedTreeNonEmpty: true, workFolder: { "work/probe-case/spec.md": "# spec\n" } };
  }
  return { streamPath: "unused.jsonl", resultSubtype: "success", producedTreeNonEmpty: true };
}

/** Write a sequence of RunResults to temp JSON files and return a real `replaySequenceRunner` over them. */
function sequenceRunner(results: readonly RunResult[]) {
  const dir = mkdtempSync(join(tmpdir(), "selfeval-observer-fixtures-"));
  const paths = results.map((r, i) => {
    const p = join(dir, `run-${i}.json`);
    writeFileSync(p, JSON.stringify(r), "utf8");
    return p;
  });
  return replaySequenceRunner(paths);
}

/** A fresh temp out path so no test clobbers another's artifact. */
function outPath(): string {
  return join(mkdtempSync(join(tmpdir(), "selfeval-observer-out-")), "routing-accuracy.json");
}

/** Per-task shapes that route every task to its own floor ⇒ a fully-correct, fully-spread baseline. */
function allCorrectShapes(): ShapeName[] {
  return FLOORS.map((f) => f as ShapeName);
}

/** Build the single-run replay sequence: N labeled-run results + k A/A-tail results (mirrors routing-probe). */
function fullSequence(labeledShapes: readonly ShapeName[], aaShape: ShapeName, k = K): RunResult[] {
  const labeled = labeledShapes.map((s) => runResultFor(s));
  const aaTail = Array.from({ length: k }, () => runResultFor(aaShape));
  return [...labeled, ...aaTail];
}

/** A recording observer: both hooks push their payloads to arrays the test then asserts over. */
function recordingObserver(): { observer: EvalObserver; events: EvalEvent[]; captures: TaskCaptureSrc[] } {
  const events: EvalEvent[] = [];
  const captures: TaskCaptureSrc[] = [];
  const observer: EvalObserver = {
    emit: (e) => events.push(e),
    onTaskComplete: (s) => captures.push(s),
  };
  return { observer, events, captures };
}

// --- AC2: per-task started/done events fire with the routed shape in the detail ------------------------

test("single-run: a task-started + task-done event fires per labeled task, carrying the routed shape", async () => {
  const labeled = allCorrectShapes();
  const { observer, events } = recordingObserver();
  const runner = sequenceRunner(fullSequence(labeled, AA_FLOOR));

  await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: outPath(), k: K, observer, runId: "run-xyz" });

  // The labeled loop emits one started + one done per task (the A/A tail is the fallback path, not the loop, so
  // its runs do NOT emit task events — only the N labeled tasks do).
  const started = events.filter((e) => e.kind === "task-started");
  const done = events.filter((e) => e.kind === "task-done");
  assert.equal(started.length, N, "one task-started per labeled task");
  assert.equal(done.length, N, "one task-done per labeled task");

  // Every event carries the run id and a position marker; each done line names the routed shape for its task.
  for (let i = 0; i < N; i++) {
    assert.equal(started[i]!.runId, "run-xyz");
    assert.match(started[i]!.detail, new RegExp(`${i + 1}/${N} ${TASK_IDS[i]}`));
    assert.equal(done[i]!.runId, "run-xyz");
    assert.match(done[i]!.detail, new RegExp(`${TASK_IDS[i]} → ${labeled[i]}`));
    assert.match(done[i]!.detail, /\(\d+ms\)/, "done detail carries a timing");
    assert.match(started[i]!.ts, /^\d{4}-\d{2}-\d{2}T/, "ISO timestamp");
  }
});

// --- AC1 capture seam: onTaskComplete fires per task carrying sandboxDir/streamPath/shape --------------

test("single-run: onTaskComplete fires once per labeled task with sandboxDir, streamPath, shape, timing", async () => {
  const labeled = allCorrectShapes();
  const { observer, captures } = recordingObserver();
  const runner = sequenceRunner(fullSequence(labeled, AA_FLOOR));

  await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: outPath(), k: K, observer });

  assert.equal(captures.length, N, "one capture per labeled task");
  for (let i = 0; i < N; i++) {
    const cap = captures[i]!;
    assert.equal(cap.taskId, TASK_IDS[i], "capture carries the task id");
    assert.equal(cap.shape, labeled[i], "capture carries the routed shape");
    assert.ok(cap.sandboxDir.length > 0, "capture carries a sandbox dir");
    assert.equal(cap.streamPath, join(cap.sandboxDir, "stream.jsonl"), "stream path is under the sandbox dir");
    assert.equal(typeof cap.timingMs, "number", "capture carries a timing");
    assert.equal(cap.runIndex, undefined, "single-run capture omits runIndex");
  }
});

// --- AC5: with NO observer, behavior is unchanged (the seam is purely additive) ------------------------

test("no observer: the probe runs and scores identically (no events, no captures, no throw)", async () => {
  const labeled = allCorrectShapes();
  const runner = sequenceRunner(fullSequence(labeled, AA_FLOOR));

  // Run WITHOUT an observer — must behave exactly as today and reach a scored artifact.
  const result = await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: outPath(), k: K });
  assert.equal(result.artifact.condition, "scored");
});

// --- AC2 (gate path): a fired control gate emits a gate-fired event with the verdict -------------------

test("aborted run: a saturation collapse emits a gate-fired event carrying the verdict", async () => {
  // Everything dispatches to the A/A floor ⇒ A/A + positive pass, saturation fires (no spread).
  const labeled = Array.from({ length: N }, () => AA_FLOOR);
  const { observer, events } = recordingObserver();
  const runner = sequenceRunner(fullSequence(labeled, AA_FLOOR));

  const result = await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: outPath(), k: K, observer });

  assert.equal(result.artifact.condition, "aborted");
  const gate = events.find((e) => e.kind === "gate-fired");
  assert.ok(gate, "a gate-fired event was emitted");
  assert.equal(gate!.detail, "no-discriminating-power", "gate detail is the firing verdict");
});

// --- multi-run: onTaskComplete carries runIndex so the store can disambiguate `.r<i>` task dirs --------

test("runs=3: each per-run capture carries its runIndex (multi-run disambiguation)", async () => {
  const runs = 3;
  // Task-major layout: N tasks * runs runs, every run routes to its floor (stable + correct ⇒ scored).
  const seq: RunResult[] = [];
  for (const f of FLOORS) {
    for (let r = 0; r < runs; r++) seq.push(runResultFor(f as ShapeName));
  }
  const { observer, captures } = recordingObserver();
  const runner = sequenceRunner(seq);

  await runRoutingProbe({ fixtureDir: MINI_FIXTURE_DIR, runner, outPath: outPath(), k: K, runs, observer });

  assert.equal(captures.length, N * runs, "one capture per task per run");
  // The first task's three captures carry runIndex 0,1,2.
  const firstTaskCaptures = captures.filter((c) => c.taskId === TASK_IDS[0]);
  assert.deepEqual(
    firstTaskCaptures.map((c) => c.runIndex),
    [0, 1, 2],
    "multi-run captures carry the 0-based run index",
  );
});
