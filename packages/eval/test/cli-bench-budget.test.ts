// The `--budget-usd` acceptance, end-to-end through `main(argv, { runner, judge })` with ZERO API spend — which is
// the whole point: burning real credit to prove a cost guard would be self-defeating. The seam is the injected
// runner: a fake that emits a `stream.jsonl` carrying a CHOSEN `total_cost_usd` and surfaces it on `RunResult.cost`
// exactly as `io/live.ts` does when it parses the trailing `result` envelope (that parse is covered in
// `io-completion-cost.test.ts`, so the chain stream → RunResult.cost → record → census is tested end to end).
//
// The matrix is `bm-clamp × --k 8` — one fixture repeated, so the fake runner needn't route by prompt while still
// giving the admission gate a queue long enough to stop partway through. The pure ledger arithmetic lives in
// `bench-budget.test.ts`; this file asserts the OBSERVABLE behavior of the command: what runs, what is stored,
// what is printed, and what exit code comes back.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.ts";
import type { Invocation, RunCost, RunResult, Runner, Sandbox } from "../src/io/port.ts";
import { seedSandbox } from "../src/io/sandbox.ts";
import type { JudgeFn } from "../src/judge/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const BENCH_MINI_DIR = join(HERE, "fixtures", "bench-mini");
const BM_CLAMP_GOLDEN = join(BENCH_MINI_DIR, "bm-clamp", "golden");

/** The matrix size every budget case is driven at — long enough that a stop leaves an unmistakable remainder. */
const PLANNED = 8;

function freshRunsRoot(): string {
  return mkdtempSync(join(tmpdir(), "selfeval-budget-runs-"));
}

// --- the canned content-keyed judge (zero API), mirroring cli-bench.test.ts ---------------------------------------

function subjectOf(prompt: string): string {
  const m = /=== SUBJECT UNDER TEST ===\n([\s\S]*?)\n\nReturn ONLY a JSON object/.exec(prompt);
  return m ? m[1]! : prompt;
}

function cannedJudge(prompt: string, _model: string): string {
  const subject = subjectOf(prompt);
  const low =
    /BUG:|\bpoor\b|\bweak\b|is to be ADDED|starts empty|STUB|not implemented|\bTODO\b/i.test(
      subject,
    );
  const dim = low ? 0 : 2;
  const dims = {
    meetsIntent: dim,
    correct: dim,
    soundCode: dim,
    complete: dim,
    forkSurfacing: dim,
    decisionSoundness: dim,
    accountability: dim,
    scope: dim,
    coherence: dim,
  };
  return JSON.stringify({ dimensions: dims, rationale: low ? "weak" : "strong" });
}

const GOOD_TRAIL =
  "# Spec: clamp\n\n## Decisions surfaced\nBoundary semantics chosen; override hint given. Crisp scope.\n";

// --- the fake runner: a chosen per-task cost, emitted through a real stream ---------------------------------------

/**
 * A fake runner that plants the bm-clamp golden tree (so the run scores and its oracle passes) and writes a
 * `stream.jsonl` whose trailing `result` envelope carries `costUsd` — or omits `total_cost_usd` entirely when
 * `costUsd` is undefined, which is the UNMEASURABLE task the budget must refuse to treat as free. Like the live
 * runner, it surfaces the cost it emitted on `RunResult.cost`.
 */
function costedRunner(costUsd: number | undefined): { runner: Runner; started: () => number } {
  let started = 0;
  const runner: Runner = {
    run(invocation: Invocation, sandbox: Sandbox): Promise<RunResult> {
      started++;
      seedSandbox(sandbox.workingDir, BM_CLAMP_GOLDEN);

      const slugDir = join(sandbox.workingDir, ".agentry", "work", "bm-clamp");
      mkdirSync(slugDir, { recursive: true });
      writeFileSync(join(slugDir, "spec.md"), GOOD_TRAIL, "utf8");

      const envelope = {
        type: "result",
        subtype: "success",
        is_error: false,
        ...(costUsd !== undefined ? { total_cost_usd: costUsd } : {}),
        duration_ms: 1000,
        num_turns: 3,
      };
      writeFileSync(invocation.streamPath, `${JSON.stringify(envelope)}\n`, "utf8");

      const cost: RunCost = {
        durationMs: 1000,
        numTurns: 3,
        ...(costUsd !== undefined ? { totalCostUsd: costUsd } : {}),
      };
      return Promise.resolve({
        streamPath: invocation.streamPath,
        producedTreeNonEmpty: true,
        resultSubtype: "success",
        cost,
      });
    },
  };
  return { runner, started: () => started };
}

/** Drive `run bench` over bm-clamp × k=8 with the given extra flags, capturing stderr. */
async function runBench(
  runsRoot: string,
  runId: string,
  runner: Runner,
  extra: readonly string[],
): Promise<{ code: number; stderr: string }> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr.write as unknown as (s: string) => boolean) = (s: string) => {
    chunks.push(String(s));
    return true;
  };
  let code: number;
  try {
    code = await main(
      [
        "run",
        "bench",
        "--fixtures-dir",
        BENCH_MINI_DIR,
        "--fixture",
        "bm-clamp",
        "--k",
        String(PLANNED),
        "--plugin-dir",
        REPO_ROOT,
        "--runs-root",
        runsRoot,
        "--run-id",
        runId,
        ...extra,
      ],
      { runner, judge: cannedJudge as JudgeFn },
    );
  } finally {
    (process.stderr.write as unknown as typeof orig) = orig;
  }
  return { code, stderr: chunks.join("") };
}

/** Read back the stored artifact the run persisted into `summary.json`. */
function storedArtifact(
  runsRoot: string,
  runId: string,
): {
  condition: string;
  census: { costUsd: number | null }[];
  budget?: {
    capUsd: number;
    spentUsd: number;
    tasksPlanned: number;
    tasksRun: number;
    tasksEstimated: number;
    projectionUsd: number;
    concurrency: number;
    stopReason: string;
  };
} {
  return JSON.parse(readFileSync(join(runsRoot, runId, "summary.json"), "utf8")).artifact;
}

// --- cost is measured -----------------------------------------------------------------------------------

test("every task's record carries the real cost read from its settled stream — not zero, not absent", async () => {
  const runsRoot = freshRunsRoot();
  const { runner } = costedRunner(0.5);

  const { code } = await runBench(runsRoot, "budget-cost", runner, []);

  assert.equal(code, 0);
  const artifact = storedArtifact(runsRoot, "budget-cost");
  assert.equal(artifact.census.length, PLANNED);
  for (const row of artifact.census) {
    assert.equal(
      row.costUsd,
      0.5,
      "the census carries the measured per-task cost, so it survives into the store",
    );
  }
});

// --- the cap stops the run, and the partial says so ------------------------------------------------

test("--budget-usd stops the run partway and reports how many of the planned tasks ran", async () => {
  const runsRoot = freshRunsRoot();
  const { runner, started } = costedRunner(0.5);

  // seed 1.00 gates task 1; thereafter the projection is the measured 0.50, so 3 tasks fit under 1.50.
  const { code, stderr } = await runBench(runsRoot, "budget-stop", runner, [
    "--budget-usd",
    "1.50",
  ]);

  assert.equal(code, 0, "a budget stop is not an error — the tool did exactly what it was asked");
  assert.equal(started(), 3, "the run STOPPED starting tasks; it did not run all 8");

  const { budget } = storedArtifact(runsRoot, "budget-stop");
  assert.ok(budget !== undefined, "a capped run is stamped with its budget");
  assert.equal(budget.stopReason, "budget-exhausted");
  assert.equal(budget.tasksPlanned, PLANNED);
  assert.equal(budget.tasksRun, 3);
  assert.equal(budget.spentUsd, 1.5);
  assert.equal(budget.capUsd, 1.5);
  assert.equal(budget.concurrency, 1);

  assert.match(stderr, /PARTIAL BENCH/, "the terminal summary cannot be missed");
  assert.match(stderr, /ran 3 of 8 planned task\(s\)/);
});

// --- the partial is REAL data — scored, persisted, reportable --------------------------------------------

test("a partial run is scored and persisted exactly like a full one, and `report <id>` works on it", async () => {
  const runsRoot = freshRunsRoot();
  const resultsRoot = mkdtempSync(join(tmpdir(), "selfeval-budget-results-"));
  const { runner } = costedRunner(0.5);

  await runBench(runsRoot, "budget-partial", runner, ["--budget-usd", "1.50"]);

  const artifact = storedArtifact(runsRoot, "budget-partial");
  assert.equal(artifact.condition, "scored", "the tasks that completed are scored, not discarded");
  assert.equal(artifact.census.length, 3, "the census holds exactly the tasks that ran");

  const summary = JSON.parse(
    readFileSync(join(runsRoot, "budget-partial", "summary.json"), "utf8"),
  );
  assert.equal(summary.taskCount, 3, "the run-level taskCount is the tasks actually run");

  const code = await main([
    "report",
    "budget-partial",
    "--runs-root",
    runsRoot,
    "--results-root",
    resultsRoot,
  ]);
  assert.equal(code, 0, "the stored partial is reportable offline, with zero API");
});

// --- the overshoot bound is stated, not implied -----------------------------------------------------------

test("the run's own output states that the cap stops NEW tasks and can be exceeded per concurrency slot", async () => {
  const runsRoot = freshRunsRoot();
  const { runner } = costedRunner(0.5);

  const { stderr } = await runBench(runsRoot, "budget-bound", runner, ["--budget-usd", "1.50"]);

  assert.match(stderr, /ADMISSION threshold, NOT a spend guarantee/);
  assert.match(stderr, /one in-flight task per concurrency slot/);
  assert.match(
    stderr,
    /1 slot\(s\) x \$0\.50 projection = \$0\.50/,
    "quantified for the concurrency actually in force",
  );
});

test("the usage text states the --budget-usd semantics and its bound", async () => {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => {
    chunks.push(String(s));
    return true;
  };
  try {
    assert.equal(await main(["help"]), 0);
  } finally {
    (process.stdout.write as unknown as typeof orig) = orig;
  }
  const usage = chunks.join("");
  assert.match(usage, /--budget-usd <n>/);
  assert.match(usage, /no mid-task abort/);
  assert.match(usage, /NOT a spend guarantee/);
  assert.match(usage, /one in-flight task per concurrency slot/);
});

// --- an unmeasurable task is never counted as free --------------------------------------------------------

test("a task that settles with NO total_cost_usd is charged the projection, and the cap still holds", async () => {
  const runsRoot = freshRunsRoot();
  const { runner, started } = costedRunner(undefined); // EVERY task is unmeasurable

  const { code, stderr } = await runBench(runsRoot, "budget-unmeasured", runner, [
    "--budget-usd",
    "1.50",
  ]);

  assert.equal(code, 0);
  // Charged $0 apiece, all 8 would have run under any cap — the guard's own failure mode. Charged the $1.00
  // projection, exactly one fits (1.00 spent, the next would project to 2.00 > 1.50).
  assert.equal(started(), 1, "the cap holds even when nothing can be measured");

  const artifact = storedArtifact(runsRoot, "budget-unmeasured");
  assert.equal(artifact.budget!.tasksEstimated, 1);
  assert.equal(artifact.budget!.spentUsd, 1.0, "charged the projection, never $0");
  assert.equal(
    artifact.census[0]!.costUsd,
    null,
    "the census still tells the truth: this cost was not measured",
  );
  assert.match(
    stderr,
    /1 task\(s\) settled UNMEASURABLE/,
    "and the estimate is surfaced, not silently absorbed",
  );
});

// --- no cap = today's behavior, exactly -------------------------------------------------------------------

test("omitting --budget-usd runs the full matrix with no admission gate and no budget stamp", async () => {
  const runsRoot = freshRunsRoot();
  const { runner, started } = costedRunner(0.5);

  const { code } = await runBench(runsRoot, "budget-absent", runner, []);

  assert.equal(code, 0);
  assert.equal(started(), PLANNED, "every planned task ran");
  const artifact = storedArtifact(runsRoot, "budget-absent");
  assert.equal(artifact.budget, undefined, "an ungated run carries no budget block at all");
});

// --- the flag is validated like every other ---------------------------------------------------------------

test("a non-numeric, zero, or negative --budget-usd is a loud usage error (exit 2)", async () => {
  for (const bad of ["abc", "0", "-1", ""]) {
    const runsRoot = freshRunsRoot();
    const { runner, started } = costedRunner(0.5);
    const { code } = await runBench(runsRoot, `budget-bad-${bad || "empty"}`, runner, [
      "--budget-usd",
      bad,
    ]);

    assert.equal(code, 2, `--budget-usd ${JSON.stringify(bad)} must exit 2`);
    assert.equal(started(), 0, "a bad cap must fail before any task spends");
  }
});
