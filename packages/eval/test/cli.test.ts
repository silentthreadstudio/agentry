// Tests for the unified self-eval CLI composition root (cli.ts / T-10). ZERO live API by construction: every test
// drives `main(argv, { runner, judge })` with an INJECTED fake runner (overlays a canned solution, no `claude -p`)
// and/or an INJECTED content-keyed judge (no `claude -p`), and asserts the composition — the store tree, the
// UNIFIED rightsizing+honesty run dir (the sibling `honesty.json`), the moat run, the offline replay, and loud
// argument errors — without a single network/subprocess call.
//
// The public subcommand set is exactly { run moat, run rightsizing } over a live conduct, plus zero-API
// `replay <id>` / `report <id>`. The HONESTY artifact is NOT a standalone conduct — it rides the SAME conduct as
// rightsizing, persisted as a sibling `honesty.json` in that one run dir (T-08's read contract).
//
// The seam the tests lean on: `main`'s second arg `{ runner, judge }` injects the zero-API impls; production leaves
// them defaulted to the live runner / real judge. A `--run-id` override pins a deterministic run dir.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { main, resolveRunsRoot } from "../src/cli.ts";
import type { RunResult, Runner } from "../src/io/port.ts";
import type { JudgeFn } from "../src/judge/index.ts";
import type { RunConfig } from "../src/store/schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const RIGHTSIZING_FIXTURE_DIR = join(PKG_ROOT, "fixtures", "rightsizing");

/** A fresh temp runs-root so no test clobbers another's tree. */
function freshRunsRoot(): string {
  return mkdtempSync(join(tmpdir(), "selfeval-cli-runs-"));
}

// --- the unified rightsizing conduct: a fake runner overlays a GOLDEN tree, a content-keyed judge passes --------
//
// `rs-clamp` is a trivial one-shot fixture. Its BROKEN overlay is the only tree carrying the marker
// "BUG: returns the wrong bound"; the GOLDEN + seed do not. So a judge keyed on that marker discriminates
// (golden HIGH, broken LOW) — clearing the controls-first gate — and scores the produced (golden-overlaid) tree
// HIGH. The runner plants the golden solution and leaves NO `.agentry/work/` artifact, so the routed shape reads
// `one-shot` (the rs-clamp floor).

// The fake judge tells golden from broken by the `BUG:` comment every broken overlay carries (and no golden does),
// rather than a specific phrase — so re-authoring a broken's defect can't silently break this control.
const BROKEN_MARKER = "BUG:";
const RS_CLAMP_GOLDEN = join(RIGHTSIZING_FIXTURE_DIR, "rs-clamp", "golden");

/** A canned verdict whose four outcome dimensions each take `n` (0/1/2) ⇒ overall = (4n)/8. */
function dimsAll(n: number): string {
  return JSON.stringify({
    dimensions: { meetsIntent: n, correct: n, soundCode: n, complete: n },
    rationale: "canned",
  });
}

/** A stable + discriminating judge: a broken-marked subject → 0.0, anything else → 1.0 (clears controls + scores high). */
function discriminatingJudge(): { judge: JudgeFn; calls: () => number } {
  let calls = 0;
  const judge: JudgeFn = (prompt) => {
    calls++;
    return prompt.includes(BROKEN_MARKER) ? dimsAll(0) : dimsAll(2);
  };
  return { judge, calls: () => calls };
}

/**
 * A fake runner that PLANTS the golden solution into the sandbox (so the captured produced tree judges HIGH) and
 * claims completion in the stream — proving the live-runner contract without `claude -p`. It leaves no
 * `.agentry/work/` artifact ⇒ the routed shape reads `one-shot`.
 */
function goldenPlantRunner(): { runner: Runner; calls: () => number } {
  let calls = 0;
  const runner: Runner = {
    async run(invocation, sandbox): Promise<RunResult> {
      calls++;
      cpSync(RS_CLAMP_GOLDEN, sandbox.workingDir, { recursive: true });
      writeFileSync(invocation.streamPath, `${JSON.stringify({ type: "result", subtype: "success", result: "done — clamp added" })}\n`, "utf8");
      return { streamPath: invocation.streamPath, resultSubtype: "success", producedTreeNonEmpty: true };
    },
  };
  return { runner, calls: () => calls };
}

// --- default runs-root is anchored to the eval package, NOT to CWD (the path-nesting fix) ----------

test("the default runs-root resolves to <eval>/runs (package-anchored), independent of CWD", () => {
  const expected = join(HERE, "..", "runs");
  const resolved = resolveRunsRoot({});

  assert.equal(resolved, join(expected));
  assert.ok(resolved.endsWith(`eval${sep}runs`), `expected a path ending in eval/runs, got ${resolved}`);
  assert.ok(!resolved.endsWith(`eval${sep}eval${sep}runs`), "must NOT nest to eval/eval/runs");
});

test("the default runs-root is the same regardless of process.cwd()", () => {
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
  const custom = freshRunsRoot();
  assert.equal(resolveRunsRoot({ runsRoot: custom }), custom);

  const original = process.cwd();
  try {
    process.chdir(tmpdir());
    assert.equal(resolveRunsRoot({ runsRoot: "my-runs" }), join(process.cwd(), "my-runs"));
  } finally {
    process.chdir(original);
  }
});

// --- run rightsizing: the UNIFIED conduct writes the run dir + the sibling honesty.json -----------------

test("run rightsizing writes a complete runs/<id>/ with kind=rightsizing AND a sibling honesty.json", async () => {
  const { runner } = goldenPlantRunner();
  const { judge } = discriminatingJudge();
  const runsRoot = freshRunsRoot();

  const code = await main(
    [
      "run", "rightsizing",
      "--fixtures-dir", RIGHTSIZING_FIXTURE_DIR,
      "--fixture", "rs-clamp", // restrict the matrix to the one trivial fixture (the loader still validates the corpus)
      "--plugin-dir", PKG_ROOT, // the Agentry cell declares loadsPlugin; the fake runner ignores the path, runCell just requires it present
      "--runs-root", runsRoot,
      "--run-id", "cli-rightsizing",
    ],
    { runner, judge },
  );

  assert.equal(code, 0);
  const runDir = join(runsRoot, "cli-rightsizing");

  // config.json — the reproducibility header, stamped kind=rightsizing.
  const config = JSON.parse(readFileSync(join(runDir, "config.json"), "utf8"));
  assert.equal(config.runId, "cli-rightsizing");
  assert.equal(config.kind, "rightsizing");
  assert.equal(config.fixtureDir, RIGHTSIZING_FIXTURE_DIR);

  // summary.json — wraps the rightsizing artifact verbatim; controls passed ⇒ a scored (not aborted) artifact.
  const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
  assert.equal(summary.kind, "rightsizing");
  assert.notEqual(summary.artifact.condition, "aborted");

  // honesty.json — the SIBLING artifact riding the SAME conduct (T-08 read contract); scored, with the pure overclaim gap.
  const honestyPath = join(runDir, "honesty.json");
  assert.ok(existsSync(honestyPath), "honesty.json was written beside the rightsizing summary");
  const honesty = JSON.parse(readFileSync(honestyPath, "utf8"));
  assert.equal(honesty.condition, "scored");
  assert.ok(honesty.overclaim !== undefined, "the scored honesty artifact carries the overclaim gap");

  // events.jsonl — at least one per-task lifecycle line, every line stamped with the run id.
  const eventLines = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n");
  assert.ok(eventLines.length >= 1, "at least one event line was appended");
  assert.ok(eventLines.every((l) => JSON.parse(l).runId === "cli-rightsizing"), "every event carries the run id");
});

test("run rightsizing stdout is exactly the run dir (script-friendly)", async () => {
  const { runner } = goldenPlantRunner();
  const { judge } = discriminatingJudge();
  const runsRoot = freshRunsRoot();

  const written: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => {
    written.push(s);
    return true;
  };
  try {
    const code = await main(
      ["run", "rightsizing", "--fixtures-dir", RIGHTSIZING_FIXTURE_DIR, "--fixture", "rs-clamp", "--plugin-dir", PKG_ROOT, "--runs-root", runsRoot, "--run-id", "cli-stdout"],
      { runner, judge },
    );
    assert.equal(code, 0);
  } finally {
    (process.stdout.write as unknown as typeof orig) = orig;
  }
  assert.equal(written.join(""), `${join(runsRoot, "cli-stdout")}\n`);
});

// --- replay: offline re-analysis of a stored run, zero API ---------------------------------------------

/** Pre-seed a stored run on disk (config.json + a spec-bearing work tree) so replay can re-derive its shape offline. */
function seedStoredRun(runsRoot: string, runId: string, specs: Record<string, string>): void {
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const config: RunConfig = { runId, kind: "rightsizing", fixtureDir: RIGHTSIZING_FIXTURE_DIR, startedAt: "2026-06-17T00:00:00.000Z" };
  writeFileSync(join(runDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  for (const [taskId, spec] of Object.entries(specs)) {
    const slugDir = join(runDir, "tasks", taskId, "work", taskId);
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "spec.md"), spec, "utf8");
  }
}

test("replay <id> re-derives stored task shapes offline (no runner, no judge)", async () => {
  const runsRoot = freshRunsRoot();
  // A spec-only stored task ⇒ spec-first; nothing else is needed (replay reads from disk only).
  seedStoredRun(runsRoot, "stored-run", { "rs-clamp": "# spec\n" });

  const code = await main(["replay", "stored-run", "--runs-root", runsRoot]);
  assert.equal(code, 0); // pure fs read, no injected deps needed — proves the offline path takes no live call.
});

// --- argument parsing errors exit non-zero loudly -----------------------------------------------------

test("an unknown command exits 2 (loud usage error)", async () => {
  assert.equal(await main(["frobnicate"]), 2);
});

test("an unknown run subcommand exits 2", async () => {
  assert.equal(await main(["run", "routing", "--runs-root", freshRunsRoot()]), 2);
});

test("run rightsizing without --fixtures-dir exits 2", async () => {
  assert.equal(await main(["run", "rightsizing", "--runs-root", freshRunsRoot()]), 2);
});

test("run moat without --fixture exits 2", async () => {
  assert.equal(await main(["run", "moat", "--runs-root", freshRunsRoot()]), 2);
});

test("an unknown flag exits 2", async () => {
  assert.equal(await main(["run", "rightsizing", "--fixtures-dir", RIGHTSIZING_FIXTURE_DIR, "--bogus", "x"]), 2);
});

test("replay of a missing run dir exits 1 (runtime fault, not a usage error)", async () => {
  assert.equal(await main(["replay", "does-not-exist", "--runs-root", freshRunsRoot()]), 1);
});
