// Tests for the probe driver + artifact emitter + headless command (T-5 / AC3, AC4, AC8, AC9a/b, AC10).
// ZERO API spend: every case drives the probe through the REAL `replaySequenceRunner` over recorded
// `RunResult` fixtures (one per `runner.run()` call). Each recorded result carries the WORK-FOLDER ARTIFACT
// layout its shape implies (autopilot-design §2); the replay runner plants those under the sandbox's
// `.agentry/work/*`, so the probe runs the genuine artifact-based extract→control→score path offline. The
// forced cases (a collapsed shape set, an A/A split) prove the GATED ORDER (ADR-004): a fired gate aborts
// BEFORE scoring and emits NO accuracy number.
//
// HOW THE A/A k-REPEATS ARE SOURCED: `runRoutingProbe` runs the labeled set once each (N calls), THEN runs the
// designated A/A task (the first labeled task) EXACTLY k more times (k calls). So a replay sequence is
// [ ...N task results, ...k A/A results ]. The tests build that sequence explicitly; the A/A tail is the last
// k entries, and feeding k identical results there proves unanimity, a split there proves the noise verdict.

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

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_FIXTURE_DIR = join(HERE, "..", "fixtures", "routing");

/**
 * A recorded RunResult whose work-folder artifacts encode the given shape (autopilot-design §2):
 *   - decompose  → a `plan.md` planted in a work folder;
 *   - spec-first → a `spec.md` only;
 *   - one-shot   → no work-folder artifacts, with a clean settle (success) + a non-empty produced tree.
 * The replay runner materializes `workFolder` under the sandbox before the probe's `extractShape` scans it.
 * `streamPath` is required by the type but no longer the shape input (kept for provenance).
 */
function runResultFor(shape: "one-shot" | "spec-first" | "decompose"): RunResult {
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

// The real shipped fixture's 7 tasks in order — its task[0] floor (the A/A + positive-control case) is one-shot.
const TASKS = loadRoutingFixture(join(REAL_FIXTURE_DIR, "tasks.yaml"));
const N = TASKS.length;
const K = 3;

/**
 * Build the full replay sequence for a probe run: N labeled-run results followed by k A/A-tail results.
 * `labeledShapes` maps each of the N tasks (in fixture order) to the shape its recorded run dispatches.
 */
function fullSequence(labeledShapes: readonly ("one-shot" | "spec-first" | "decompose")[], aaShape: "one-shot" | "spec-first" | "decompose", k = K): RunResult[] {
  assert.equal(labeledShapes.length, N, "labeledShapes must cover every task");
  const labeled = labeledShapes.map((s) => runResultFor(s));
  const aaTail = Array.from({ length: k }, () => runResultFor(aaShape));
  return [...labeled, ...aaTail];
}

// --- AC3 / AC4: a mixed-shape fixture produces a scored artifact ---------------------------------------

test("mixed-shape run => scored artifact with accuracy, confusion matrix, over/under-routes, early-signal caveat", async () => {
  // task[0] floor is one-shot — dispatch it one-shot so the positive control passes and A/A is unanimous.
  // The rest span shapes so saturation sees spread; a couple deliberately deviate so over/under routes appear.
  const labeled: ("one-shot" | "spec-first" | "decompose")[] = [
    "one-shot",   // routing-format-price (floor one-shot)   => correct
    "decompose",  // routing-version-flag (floor one-shot)   => OVER-route
    "spec-first", // routing-dedupe-key   (floor spec-first) => correct
    "one-shot",   // routing-token-ttl    (floor spec-first, must-escalate) => UNDER-route (trap one-shotted)
    "spec-first", // routing-search-faster(floor spec-first) => correct
    "decompose",  // routing-users-pagination (floor decompose) => correct
    "spec-first", // routing-notifications (floor decompose) => UNDER-route
  ];
  const runner = sequenceRunner(fullSequence(labeled, "one-shot"));
  const out = outPath();

  const result = await runRoutingProbe({ fixtureDir: REAL_FIXTURE_DIR, runner, outPath: out, k: K });

  assert.equal(result.artifact.condition, "scored");
  assert.equal(typeof result.artifact.accuracy, "number");
  // 4 of 7 correct (format-price, dedupe-key, search-faster, users-pagination).
  assert.equal(result.artifact.accuracy, 4 / 7);
  assert.ok(result.artifact.confusionMatrix && result.artifact.confusionMatrix.length > 0, "matrix populated");
  assert.ok(result.artifact.overRoutes!.some((r) => r.taskId === "routing-version-flag"), "over-route readable");
  assert.ok(result.artifact.underRoutes!.some((r) => r.taskId === "routing-token-ttl"), "under-route readable");
  assert.match(result.artifact.earlySignalCaveat, /Early-signal/);

  // AC10: the artifact written to disk matches the returned one (the only score input was the dispatched shape).
  const onDisk = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(onDisk.accuracy, 4 / 7);
  assert.equal(onDisk.condition, "scored");
});

// --- AC8: a collapsed dispatch set aborts at saturation, BEFORE scoring --------------------------------

test("collapsed-shape run => saturationGuard aborts, NO accuracy emitted, abort precedes scoring", async () => {
  // Everything dispatches to one-shot (= task[0]'s floor, so positive control + A/A both pass first), leaving
  // saturation as the gate that must fire. No spread => no-discriminating-power, no score.
  const labeled = Array.from({ length: N }, () => "one-shot" as const);
  const runner = sequenceRunner(fullSequence(labeled, "one-shot"));
  const out = outPath();

  const result = await runRoutingProbe({ fixtureDir: REAL_FIXTURE_DIR, runner, outPath: out, k: K });

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
  // A spread labeled run (so saturation passes) with a unanimous A/A tail (all one-shot, matching task[0]).
  const labeled: ("one-shot" | "spec-first" | "decompose")[] = [
    "one-shot", "spec-first", "spec-first", "spec-first", "spec-first", "decompose", "decompose",
  ];
  const runner = sequenceRunner(fullSequence(labeled, "one-shot"));
  const result = await runRoutingProbe({ fixtureDir: REAL_FIXTURE_DIR, runner, outPath: outPath(), k: K });

  // Unanimity held (and saturation/positive passed) => the run reached scoring, not an abort.
  assert.equal(result.artifact.condition, "scored");
});

test("A/A: a split in the A/A tail => instrument-measures-noise verdict, NO score", async () => {
  // Labeled run spreads (saturation would pass) but the A/A tail is NOT unanimous => the run must abort at A/A,
  // before saturation or scoring. Build the tail by hand: [one-shot, one-shot, spec-first].
  const labeled: ("one-shot" | "spec-first" | "decompose")[] = [
    "one-shot", "spec-first", "spec-first", "spec-first", "spec-first", "decompose", "decompose",
  ];
  const labeledResults = labeled.map((s) => runResultFor(s));
  const splitTail = [runResultFor("one-shot"), runResultFor("one-shot"), runResultFor("spec-first")];
  const runner = sequenceRunner([...labeledResults, ...splitTail]);

  const result = await runRoutingProbe({ fixtureDir: REAL_FIXTURE_DIR, runner, outPath: outPath(), k: K });

  assert.equal(result.artifact.condition, "aborted");
  assert.equal(result.artifact.abortVerdict, "instrument-measures-noise");
  assert.equal(result.artifact.accuracy, null);
});

// --- AC7: a planted positive-control miss aborts loudly -----------------------------------------------

test("positive control: task[0] dispatched off its planted floor => positive-control-missed, NO score", async () => {
  // task[0]'s floor is one-shot; dispatch it as decompose so the planted positive control misses. A/A is built
  // unanimous-but-wrong (all decompose) so the FIRST gate to fail is A/A? No — A/A unanimity holds (all
  // identical), so the gate that fires is the positive control. Verify it aborts there with the plumbing verdict.
  const labeled: ("one-shot" | "spec-first" | "decompose")[] = [
    "decompose", "spec-first", "spec-first", "spec-first", "spec-first", "decompose", "decompose",
  ];
  const runner = sequenceRunner(fullSequence(labeled, "decompose"));
  const result = await runRoutingProbe({ fixtureDir: REAL_FIXTURE_DIR, runner, outPath: outPath(), k: K });

  assert.equal(result.artifact.condition, "aborted");
  assert.equal(result.artifact.abortVerdict, "positive-control-missed");
  assert.equal(result.artifact.accuracy, null);
});

// --- AC9a / AC9b: the success condition with and without a threshold X ---------------------------------

test("with X provided => the condition + a computed pass/fail appear", async () => {
  const labeled: ("one-shot" | "spec-first" | "decompose")[] = [
    "one-shot", "spec-first", "spec-first", "spec-first", "spec-first", "decompose", "decompose",
  ];
  const runner = sequenceRunner(fullSequence(labeled, "one-shot"));
  // 6/7 correct here (only token-ttl floor spec-first dispatched spec-first => correct; all match except none).
  const result = await runRoutingProbe({ fixtureDir: REAL_FIXTURE_DIR, runner, outPath: outPath(), k: K, x: 0.5 });

  assert.equal(result.artifact.condition, "scored");
  assert.ok(result.artifact.successCondition, "condition present");
  assert.equal(result.artifact.successCondition!.threshold, 0.5);
  assert.equal(result.artifact.successCondition!.xUnsetMarker, undefined, "no unset marker when X is set");
  assert.ok(result.artifact.passFail, "pass/fail computed when X is set");
  assert.equal(typeof result.artifact.passFail!.pass, "boolean");
  assert.equal(typeof result.artifact.passFail!.accuracyPass, "boolean");
  assert.equal(typeof result.artifact.passFail!.zeroTrapUnderroute, "boolean");
});

test("without X => the success condition carries the 'X unset' marker and NO pass/fail", async () => {
  const labeled: ("one-shot" | "spec-first" | "decompose")[] = [
    "one-shot", "spec-first", "spec-first", "spec-first", "spec-first", "decompose", "decompose",
  ];
  const runner = sequenceRunner(fullSequence(labeled, "one-shot"));
  const result = await runRoutingProbe({ fixtureDir: REAL_FIXTURE_DIR, runner, outPath: outPath(), k: K });

  assert.equal(result.artifact.condition, "scored");
  assert.ok(result.artifact.successCondition, "condition present even with X unset");
  assert.equal(result.artifact.successCondition!.threshold, null);
  assert.match(result.artifact.successCondition!.xUnsetMarker ?? "", /X unset/);
  assert.equal(result.artifact.passFail, undefined, "no pass/fail until X is set");
});

// --- AC3 (headless): command.ts --runner replay exits 0, stdout = artifact path ------------------------

test("command.ts --runner replay --fixture <dir> exits 0 and stdout is the artifact path", async () => {
  const { main } = await import("../src/routing/command.ts");

  // Build a sequence of RunResult fixtures on disk and pass them via --replay-fixtures.
  const labeled: ("one-shot" | "spec-first" | "decompose")[] = [
    "one-shot", "spec-first", "spec-first", "spec-first", "spec-first", "decompose", "decompose",
  ];
  const results = fullSequence(labeled, "one-shot");
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
      "--fixture", REAL_FIXTURE_DIR,
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
