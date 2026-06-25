// Zero-API test for the `run bench` CLI subcommand (Phase 5 of the eval reshape). It drives `main(argv, { runner,
// judge })` with an INJECTED fake runner (overlays a golden tree + leaves a `.agentry/work/<slug>/spec.md` so a
// decisionScore is produced + writes a success stream — NO `claude -p`) and a CANNED content-keyed judge (a `BUG:`
// marker ⇒ low, else high — zero API). It asserts the composition: a `run bench` over the bench-mini corpus writes a
// complete `runs/<id>/` with `config.json` (kind=bench) and a `summary.json` whose artifact carries the four axes,
// and exits 0 — without a single network/subprocess call.
//
// The bench probe defaults to the Agentry cell (loadsPlugin), so `--plugin-dir` is passed to satisfy `runCell`'s
// pluginDir requirement; the fake runner ignores the path. The matrix is restricted to one fixture (`bm-clamp`) so
// the runner needn't route by prompt — the loader still validates the whole corpus.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { main } from "../src/cli.ts";
import { seedSandbox } from "../src/io/sandbox.ts";
import type { Invocation, RunResult, Runner, Sandbox } from "../src/io/port.ts";
import type { JudgeFn } from "../src/judge/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const BENCH_MINI_DIR = join(HERE, "fixtures", "bench-mini");
const BM_CLAMP_GOLDEN = join(BENCH_MINI_DIR, "bm-clamp", "golden");

/** A fresh temp runs-root so no test clobbers another's tree. */
function freshRunsRoot(): string {
  return mkdtempSync(join(tmpdir(), "selfeval-cli-bench-runs-"));
}

// --- the canned content-keyed judge (zero API) -------------------------------------------------------------------
//
// The judge fn receives the assembled rubric PROMPT (rubric text + the subject under test) and returns raw JSON. It
// keys off markers in the SUBJECT region ONLY (the rubric prose itself contains words like "poor"/"weak"): a `BUG:`
// subject (every broken overlay carries one) scores LOW (every dim 0), else HIGH (every dim 2). A uniform per-dim
// score normalizes to overall 0 or 1 for either rubric (code 4-dim / decision 5-dim), so the controls' golden↔broken
// discrimination holds.

/** Extract just the subject text the engine delimits, so a marker in the rubric prose can't skew the canned score. */
function subjectOf(prompt: string): string {
  const m = /=== SUBJECT UNDER TEST ===\n([\s\S]*?)\n\nReturn ONLY a JSON object/.exec(prompt);
  return m ? m[1]! : prompt;
}

function cannedJudge(prompt: string, _model: string): string {
  const subject = subjectOf(prompt);
  // LOW also covers the INCOMPLETE seed-only tree (target unimplemented) — the Axis-B code control anchors LOW on the
  // seed alone, so an unimplemented stub must score low (fails meetsIntent + complete).
  const low = /BUG:|\bpoor\b|\bweak\b|is to be ADDED|starts empty|STUB|not implemented|\bTODO\b/i.test(subject);
  const dim = low ? 0 : 2;
  const dims = {
    meetsIntent: dim, correct: dim, soundCode: dim, complete: dim,
    forkSurfacing: dim, decisionSoundness: dim, accountability: dim, scope: dim, coherence: dim,
  };
  return JSON.stringify({ dimensions: dims, rationale: low ? "weak" : "strong" });
}

// A clearly-good decision trail (no low markers) so a decisionScore is produced and judged HIGH.
const GOOD_TRAIL = "# Spec: clamp\n\n## Decisions surfaced\nBoundary semantics chosen; override hint given. Crisp scope.\n";

/**
 * A fake runner that PLANTS the bm-clamp golden solution into the sandbox (so the captured produced tree judges HIGH
 * AND passes its oracle), leaves a `.agentry/work/bm-clamp/spec.md` decision trail (so a decisionScore is produced),
 * and claims completion in the stream — proving the live-runner contract without `claude -p`.
 */
function goldenPlantRunner(): Runner {
  return {
    run(invocation: Invocation, sandbox: Sandbox): Promise<RunResult> {
      seedSandbox(sandbox.workingDir, BM_CLAMP_GOLDEN);

      const slugDir = join(sandbox.workingDir, ".agentry", "work", "bm-clamp");
      mkdirSync(slugDir, { recursive: true });
      writeFileSync(join(slugDir, "spec.md"), GOOD_TRAIL, "utf8");

      writeFileSync(invocation.streamPath, `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`, "utf8");
      return Promise.resolve({ streamPath: invocation.streamPath, producedTreeNonEmpty: true, resultSubtype: "success" });
    },
  };
}

// --- run bench: the conduct-once → four-axis bench writes the run dir ---------------------------------------------

test("run bench writes a complete runs/<id>/ with kind=bench and a scored summary.json carrying the four axes", async () => {
  const runner = goldenPlantRunner();
  const judge: JudgeFn = cannedJudge;
  const runsRoot = freshRunsRoot();

  const code = await main(
    [
      "run", "bench",
      "--fixtures-dir", BENCH_MINI_DIR,
      "--fixture", "bm-clamp", // restrict the matrix to the one trivial fixture (the loader still validates the corpus)
      "--plugin-dir", PKG_ROOT, // the Agentry cell declares loadsPlugin; the fake runner ignores the path, runCell just requires it present
      "--runs-root", runsRoot,
      "--run-id", "cli-bench",
    ],
    { runner, judge },
  );

  assert.equal(code, 0);
  const runDir = join(runsRoot, "cli-bench");

  // config.json — the reproducibility header, stamped kind=bench.
  const config = JSON.parse(readFileSync(join(runDir, "config.json"), "utf8"));
  assert.equal(config.runId, "cli-bench");
  assert.equal(config.kind, "bench");
  assert.equal(config.fixtureDir, BENCH_MINI_DIR);

  // summary.json — wraps the bench artifact verbatim; controls passed ⇒ a scored (not aborted) artifact with 4 axes.
  const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
  assert.equal(summary.kind, "bench");
  assert.equal(summary.artifact.condition, "scored");
  const axes = summary.artifact.axes;
  assert.ok(axes !== undefined, "the scored artifact carries the four axes");
  assert.ok(axes.decisionQuality !== undefined, "Axis A — decisionQuality");
  assert.ok(axes.codeQuality !== undefined, "Axis B — codeQuality");
  assert.equal(typeof axes.overclaimRate, "number", "Axis C — overclaimRate");
  assert.equal(typeof axes.escapedDefectRate, "number", "Axis D — escapedDefectRate");

  // The planted golden + trail ⇒ a decisionScore was produced (Axis A's n includes the single matrix cell).
  assert.equal(axes.decisionQuality.n, 1, "the planted spec.md trail yields a decisionScore");
});

test("run bench without --fixtures-dir exits 2 (loud usage error)", async () => {
  assert.equal(await main(["run", "bench", "--runs-root", freshRunsRoot()]), 2);
});

test("run bench stdout is exactly the run dir (script-friendly)", async () => {
  const runner = goldenPlantRunner();
  const runsRoot = freshRunsRoot();

  const written: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => {
    written.push(s);
    return true;
  };
  try {
    const code = await main(
      ["run", "bench", "--fixtures-dir", BENCH_MINI_DIR, "--fixture", "bm-clamp", "--plugin-dir", PKG_ROOT, "--runs-root", runsRoot, "--run-id", "cli-bench-stdout"],
      { runner, judge: cannedJudge },
    );
    assert.equal(code, 0);
  } finally {
    (process.stdout.write as unknown as typeof orig) = orig;
  }
  assert.equal(written.join(""), `${join(runsRoot, "cli-bench-stdout")}\n`);
  assert.ok(existsSync(join(runsRoot, "cli-bench-stdout", "summary.json")), "the run dir holds a summary.json");
});
