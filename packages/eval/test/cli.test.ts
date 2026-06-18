// Tests for the unified self-eval CLI composition root (cli.ts / T-F). ZERO live API by construction: every test
// drives `main(argv, { runner, judge })` with an INJECTED replay runner (recorded RunResults, no `claude -p`) or
// an INJECTED canned judge (no `claude -p`), and asserts the composition — the store tree, the AC3 zero-conductor
// quality path, the offline replay, and loud argument errors — without a single network/subprocess call.
//
// The seam the tests lean on: `main`'s second arg `{ runner, judge }` injects the zero-API impls; production
// leaves them defaulted to the live runner / real judge. A `--run-id` override pins a deterministic run dir.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { sep } from "node:path";

import { main, resolveRunsRoot } from "../src/cli.ts";
import { replaySequenceRunner } from "../src/io/replay.ts";
import type { RunResult, Runner } from "../src/io/port.ts";
import { loadRoutingFixture } from "../src/routing/fixture.ts";
import type { JudgeFn } from "../src/quality/judge.ts";
import type { RunConfig } from "../src/store/schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MINI_FIXTURE_DIR = join(HERE, "fixtures", "routing-mini");
const QUALITY_FIXTURE_DIR = join(HERE, "..", "fixtures", "quality");

const MINI_TASKS = loadRoutingFixture(join(MINI_FIXTURE_DIR, "tasks.yaml"));
const N = MINI_TASKS.length;
const FLOORS = MINI_TASKS.map((t) => t.correctFloor);
const TASK_IDS = MINI_TASKS.map((t) => t.id);
const K = 3; // the probe's default A/A repeats (runs=1 < k ⇒ a separate k-call A/A tail).

// --- replay-runner fixtures (mirror routing-probe.test.ts: a recorded RunResult encodes its shape) -----

/** A recorded RunResult whose work-folder artifacts encode `shape` (plan ⇒ decompose, spec ⇒ spec-first, none ⇒ one-shot). */
function runResultFor(shape: "one-shot" | "spec-first" | "decompose"): RunResult {
  if (shape === "decompose") {
    return { streamPath: "unused.jsonl", producedTreeNonEmpty: true, workFolder: { "work/probe-case/plan.md": "# plan\n" } };
  }
  if (shape === "spec-first") {
    return { streamPath: "unused.jsonl", producedTreeNonEmpty: true, workFolder: { "work/probe-case/spec.md": "# spec\n" } };
  }
  return { streamPath: "unused.jsonl", resultSubtype: "success", producedTreeNonEmpty: true };
}

/**
 * A replay runner over the full single-run sequence (N labeled results + k A/A-tail results), wrapped so the test
 * can COUNT calls. Every task routed to its own labeled floor ⇒ fully correct + fully spread ⇒ all gates pass.
 */
function fullCorrectRunner(): { runner: Runner; calls: () => number } {
  const dir = mkdtempSync(join(tmpdir(), "selfeval-cli-fixtures-"));
  const labeled = FLOORS.map((s) => runResultFor(s as "one-shot" | "spec-first" | "decompose"));
  const aaTail = Array.from({ length: K }, () => runResultFor(FLOORS[0]! as "one-shot")); // task[0] floor = one-shot.
  const paths = [...labeled, ...aaTail].map((r, i) => {
    const p = join(dir, `run-${i}.json`);
    writeFileSync(p, JSON.stringify(r), "utf8");
    return p;
  });
  const inner = replaySequenceRunner(paths);
  let calls = 0;
  const runner: Runner = {
    async run(invocation, sandbox) {
      calls++;
      // The LIVE runner tees the captured event stream to `invocation.streamPath`; the replay runner doesn't
      // (it only plants the work folder). The store's `captureTask` copies that stream out, so simulate the
      // live runner's tee here — exactly what `claude -p` would have written — so the end-to-end capture is real.
      writeFileSync(invocation.streamPath, `{"event":"replay"}\n`, "utf8");
      return inner.run(invocation, sandbox);
    },
  };
  return { runner, calls: () => calls };
}

/** A fresh temp runs-root so no test clobbers another's tree. */
function freshRunsRoot(): string {
  return mkdtempSync(join(tmpdir(), "selfeval-cli-runs-"));
}

// --- quality fixtures: a stable + discriminating canned judge, keyed on unique artifact markers ---------

const GOLD_MARKER = "first-write-wins";
const POOR_MARKER = "standard, well-understood";

/** A canned verdict whose five dimensions each take `n` (0/1/2) ⇒ overall = (5n)/10. */
function dimsAll(n: number): string {
  return JSON.stringify({
    dimensions: { forkSurfacing: n, decisionSoundness: n, accountability: n, scope: n, coherence: n },
    rationale: "canned",
  });
}

/** A counting, stable + discriminating judge: GOLD → 1.0, POOR → 0.0, any input → 0.5. */
function countingJudge(): { judge: JudgeFn; calls: () => number } {
  let calls = 0;
  const judge: JudgeFn = (prompt) => {
    calls++;
    if (prompt.includes(GOLD_MARKER)) return dimsAll(2);
    if (prompt.includes(POOR_MARKER)) return dimsAll(0);
    return dimsAll(1);
  };
  return { judge, calls: () => calls };
}

/**
 * Pre-seed a stored routing run on disk (config.json + per-task stored work/<slug>/spec.md) so the AC3 quality
 * path can reconstruct judgeable inputs WITHOUT any conductor re-run. Mirrors store-read.test.ts's fixture.
 */
function seedStoredRun(runsRoot: string, runId: string, specs: Record<string, string>): void {
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const config: RunConfig = {
    runId,
    kind: "routing",
    fixtureDir: MINI_FIXTURE_DIR,
    startedAt: "2026-06-17T00:00:00.000Z",
  };
  writeFileSync(join(runDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  for (const [taskId, spec] of Object.entries(specs)) {
    const slugDir = join(runDir, "tasks", taskId, "work", taskId);
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "spec.md"), spec, "utf8");
  }
}

// --- default runs-root is anchored to the eval package, NOT to CWD (the path-nesting fix) ----------

test("the default runs-root resolves to <eval>/runs (package-anchored), independent of CWD", () => {
  // The package root is two dirs up from this test file (test/ → packages/eval/); the default must land its
  // `runs/` there — a path ending in `eval/runs`, never the doubly-nested `eval/eval/runs` the CWD-relative
  // default produced when the CLI was invoked from inside the package.
  const expected = join(HERE, "..", "runs");
  const resolved = resolveRunsRoot({});

  assert.equal(resolved, join(expected)); // `join` normalizes the `..` so the comparison is on canonical paths.
  assert.ok(resolved.endsWith(`eval${sep}runs`), `expected a path ending in eval/runs, got ${resolved}`);
  assert.ok(!resolved.endsWith(`eval${sep}eval${sep}runs`), "must NOT nest to eval/eval/runs");
});

test("the default runs-root is the same regardless of process.cwd()", () => {
  // Compute it from two different working directories; an absolute, file-anchored default is invariant under CWD.
  const original = process.cwd();
  try {
    process.chdir(HERE);
    const fromHere = resolveRunsRoot({});
    process.chdir(tmpdir());
    const fromTmp = resolveRunsRoot({});
    assert.equal(fromHere, fromTmp);
  } finally {
    process.chdir(original);
  }
});

test("an explicit --runs-root overrides the default (resolved relative to CWD)", () => {
  const custom = freshRunsRoot(); // an absolute custom dir
  assert.equal(resolveRunsRoot({ runsRoot: custom }), custom);

  // A relative --runs-root resolves against CWD, NOT the package root — the override escape hatch for tests.
  const original = process.cwd();
  try {
    process.chdir(tmpdir());
    assert.equal(resolveRunsRoot({ runsRoot: "my-runs" }), join(process.cwd(), "my-runs"));
  } finally {
    process.chdir(original);
  }
});

// --- run routing: a replay/injected runner writes a complete runs/<id>/ -------------------------------

test("run routing with an injected replay runner writes a complete runs/<id>/ (config/summary/events/tasks)", async () => {
  const { runner } = fullCorrectRunner();
  const runsRoot = freshRunsRoot();

  const code = await main(
    ["run", "routing", "--fixture", MINI_FIXTURE_DIR, "--runs-root", runsRoot, "--run-id", "cli-routing"],
    { runner },
  );

  assert.equal(code, 0);
  const runDir = join(runsRoot, "cli-routing");

  // config.json — the reproducibility header.
  const config = JSON.parse(readFileSync(join(runDir, "config.json"), "utf8"));
  assert.equal(config.runId, "cli-routing");
  assert.equal(config.kind, "routing");
  assert.equal(config.fixtureDir, MINI_FIXTURE_DIR);

  // summary.json — wraps the probe's scored artifact verbatim; all gates passed ⇒ a scored (not aborted) artifact.
  const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
  assert.equal(summary.taskCount, N);
  assert.equal(summary.kind, "routing");
  assert.notEqual(summary.artifact.condition, "aborted");

  // events.jsonl — at least the per-task lifecycle lines were appended (AC2).
  const eventLines = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n");
  assert.ok(eventLines.length >= N, `expected >= ${N} event lines, got ${eventLines.length}`);
  assert.ok(eventLines.every((l) => JSON.parse(l).runId === "cli-routing"), "every event carries the run id");

  // tasks/ — each labeled task captured; a spec-first/decompose task carries a copied work/ tree (the keystone).
  for (const id of TASK_IDS) {
    assert.ok(existsSync(join(runDir, "tasks", id, "shape.json")), `tasks/${id}/shape.json captured`);
    assert.ok(existsSync(join(runDir, "tasks", id, "stream.jsonl")), `tasks/${id}/stream.jsonl captured`);
  }
  // task[2] is spec-first ⇒ a work/ tree was copied out of its sandbox.
  assert.ok(existsSync(join(runDir, "tasks", TASK_IDS[2]!, "work")), "a spec-bearing task captured its work/ tree");
});

// --- run quality --from-run: judges stored artifacts with ZERO conductor re-run (AC3) ------------------

test("run quality --from-run judges stored artifacts via the judge ONLY — no live conductor/runner run (AC3)", async () => {
  const runsRoot = freshRunsRoot();
  seedStoredRun(runsRoot, "stored-routing", {
    "mini-search-tuning": "# spec\nmake search faster\n",
    "mini-pagination-stack": "# spec\npaginate the listing\n",
  });
  const { judge, calls: judgeCalls } = countingJudge();

  // A runner injected purely to PROVE it is never called by the quality path (zero conductor re-run).
  let runnerCalls = 0;
  const spyRunner: Runner = {
    run() {
      runnerCalls++;
      return Promise.reject(new Error("the quality path must NOT invoke a runner"));
    },
  };

  const code = await main(
    ["run", "quality", "--fixtures", QUALITY_FIXTURE_DIR, "--from-run", "stored-routing", "--runs-root", runsRoot],
    { runner: spyRunner, judge },
  );

  assert.equal(code, 0);
  // THE AC3 DEMONSTRATION: zero runner calls — the inputs came from the stored artifacts, not a re-run.
  assert.equal(runnerCalls, 0, "no conductor/runner run — the AC3 token-bleed fix");
  // The judge DID spend (gates + the two stored inputs) — only the judge, nothing else.
  assert.ok(judgeCalls() > 0, "the judge was invoked over the stored inputs");

  // The scored artifact landed inside the stored run dir and judged exactly the two reconstructed inputs.
  const artifact = JSON.parse(readFileSync(join(runsRoot, "stored-routing", "decision-quality.json"), "utf8"));
  assert.notEqual(artifact.condition, "aborted");
  assert.equal(artifact.scores.length, 2);
  const scoredIds = artifact.scores.map((s: { taskId: string }) => s.taskId).sort();
  assert.deepEqual(scoredIds, ["mini-pagination-stack", "mini-search-tuning"]);
});

// --- replay: offline re-analysis of a stored run, zero API ---------------------------------------------

test("replay <id> re-derives stored task shapes offline (no runner, no judge)", async () => {
  const runsRoot = freshRunsRoot();
  // A spec-only stored task ⇒ spec-first; nothing else is needed (replay reads from disk only).
  seedStoredRun(runsRoot, "stored-run", { "mini-search-tuning": "# spec\n" });

  const code = await main(["replay", "stored-run", "--runs-root", runsRoot]);

  assert.equal(code, 0); // pure fs read, no injected deps needed — proves the offline path takes no live call.
});

// --- argument parsing errors exit non-zero loudly -----------------------------------------------------

test("an unknown command exits 2 (loud usage error)", async () => {
  assert.equal(await main(["frobnicate"]), 2);
});

test("run routing without --fixture exits 2", async () => {
  assert.equal(await main(["run", "routing", "--runs-root", freshRunsRoot()]), 2);
});

test("an unknown flag exits 2", async () => {
  assert.equal(await main(["run", "routing", "--fixture", MINI_FIXTURE_DIR, "--bogus", "x"]), 2);
});

test("trace without a <taskId> positional exits 2", async () => {
  assert.equal(await main(["trace", "--fixture", MINI_FIXTURE_DIR]), 2);
});

test("trace with a taskId not in the fixture exits 2 before running", async () => {
  assert.equal(await main(["trace", "no-such-task", "--fixture", MINI_FIXTURE_DIR, "--runs-root", freshRunsRoot()]), 2);
});

test("replay of a missing run dir exits 1 (runtime fault, not a usage error)", async () => {
  assert.equal(await main(["replay", "does-not-exist", "--runs-root", freshRunsRoot()]), 1);
});
