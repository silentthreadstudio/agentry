// Tests for the READ side of the artifact store (read.ts / T-E) — the AC3 token-bleed fix. Pure fs, ZERO API
// spend by construction: every test builds a fake `runs/<id>/` tree on disk (a `config.json` pointing at a tiny
// temp fixture dir + stored `tasks/<id>/work/<slug>/spec.md` files), then drives `readRunInputs`/`readRunConfig`/
// `rescoreRun` and asserts they reconstruct the quality-gate input / shape from disk WITHOUT any live call.
//
// The test reuses the real `routing-mini/tasks.yaml` (the probe tests' stable synthetic set) as the fixture the
// run is parameterized with, so the recovered `taskPrompt` is checked against the actual labeled prompt.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { readRunConfig, readRunInputs, rescoreRun } from "../src/store/read.ts";
import { loadRoutingFixture } from "../src/routing/fixture.ts";
import type { RunConfig } from "../src/store/schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MINI_FIXTURE = join(HERE, "fixtures", "routing-mini");

/**
 * Materialize a fake stored run on disk: a temp `runs/<id>/` with a `config.json` pointing at a COPY of the
 * routing-mini fixture (so the run is self-contained), and per-task `tasks/<id>/work/<slug>/spec.md` files for
 * each `specs` entry. Returns the run dir and the temp fixture dir whose `tasks.yaml` supplies the prompts.
 *
 * @param specs  taskId → { spec, plan? } the stored work tree should carry. A taskId omitted here gets NO `work/`
 *               (the one-shot / nothing-to-judge case).
 */
function makeStoredRun(specs: Record<string, { spec: string; plan?: string }>): {
  runDir: string;
  runsRoot: string;
  runId: string;
  fixtureDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "selfeval-read-"));
  const fixtureDir = join(root, "fixture");
  cpSync(MINI_FIXTURE, fixtureDir, { recursive: true });

  const runsRoot = join(root, "runs");
  const runId = "test-run";
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const config: RunConfig = {
    runId: "test-run",
    kind: "routing",
    fixtureDir,
    startedAt: "2026-06-17T00:00:00.000Z",
  };
  writeFileSync(join(runDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  for (const [taskId, { spec, plan }] of Object.entries(specs)) {
    const slugDir = join(runDir, "tasks", taskId, "work", taskId);
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "spec.md"), spec, "utf8");
    if (plan !== undefined) writeFileSync(join(slugDir, "plan.md"), plan, "utf8");
  }

  return { runDir, runsRoot, runId, fixtureDir };
}

test("readRunConfig parses the stored reproducibility header back from config.json", () => {
  const { runsRoot, runId, fixtureDir } = makeStoredRun({ "mini-search-tuning": { spec: "# spec\n" } });

  const config = readRunConfig(runsRoot, runId);

  assert.equal(config.runId, "test-run");
  assert.equal(config.kind, "routing");
  assert.equal(config.fixtureDir, fixtureDir);
});

test("readRunInputs reconstructs QualityInput[] from stored spec.md with the fixture prompt — ZERO live call", () => {
  const { fixtureDir, runsRoot, runId } = makeStoredRun({
    "mini-search-tuning": { spec: "# spec\nmake search faster\n" },
  });
  // The expected prompt comes straight from the (real) fixture the run points at — no live regeneration.
  const expectedPrompt = loadRoutingFixture(join(fixtureDir, "tasks.yaml")).find(
    (t) => t.id === "mini-search-tuning",
  )!.prompt;

  const inputs = readRunInputs(runsRoot, runId);

  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0], {
    taskId: "mini-search-tuning",
    taskPrompt: expectedPrompt,
    artifactText: "# spec\nmake search faster\n",
  });
});

test("readRunInputs concatenates spec.md + plan.md with the gate's separator when both are stored", () => {
  const { runsRoot, runId } = makeStoredRun({
    "mini-pagination-stack": { spec: "# spec\nthe spec\n", plan: "# plan\nthe plan\n" },
  });

  const inputs = readRunInputs(runsRoot, runId);

  assert.equal(inputs.length, 1);
  assert.equal(
    inputs[0]!.artifactText,
    "# spec\nthe spec\n\n\n--- PLAN ---\n\n# plan\nthe plan\n",
  );
});

test("readRunInputs skips a task with no captured work/ (a one-shot produced nothing to judge)", () => {
  // mini-format-decimals gets NO work/ entry (one-shot); mini-search-tuning does.
  const { runDir, runsRoot, runId } = makeStoredRun({
    "mini-search-tuning": { spec: "# spec\nkept\n" },
  });
  // Also create a bare task dir with no work/ to prove it is skipped, not errored.
  mkdirSync(join(runDir, "tasks", "mini-format-decimals"), { recursive: true });

  const inputs = readRunInputs(runsRoot, runId);

  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.taskId, "mini-search-tuning");
});

test("readRunInputs strips the `.r<i>` multi-run suffix to resolve the fixture prompt", () => {
  const { fixtureDir, runsRoot, runId } = makeStoredRun({
    "mini-search-tuning.r2": { spec: "# spec\nrepeat 2\n" },
  });
  const expectedPrompt = loadRoutingFixture(join(fixtureDir, "tasks.yaml")).find(
    (t) => t.id === "mini-search-tuning",
  )!.prompt;

  const inputs = readRunInputs(runsRoot, runId);

  assert.equal(inputs.length, 1);
  // taskId resolves to the base labeled id; the prompt comes from that labeled task.
  assert.equal(inputs[0]!.taskId, "mini-search-tuning");
  assert.equal(inputs[0]!.taskPrompt, expectedPrompt);
});

test("rescoreRun re-derives each stored task's shape offline from the work/ tree — no live run", () => {
  const { runsRoot, runId } = makeStoredRun({
    // a spec-only work tree ⇒ spec-first; a plan-bearing tree ⇒ decompose.
    "mini-search-tuning": { spec: "# spec\n" },
    "mini-pagination-stack": { spec: "# spec\n", plan: "# plan\n" },
  });

  const rescored = rescoreRun(runsRoot, runId);
  const byId = new Map(rescored.map((r) => [r.taskId, r.shape]));

  assert.equal(rescored.length, 2);
  assert.equal(byId.get("mini-search-tuning"), "spec-first");
  assert.equal(byId.get("mini-pagination-stack"), "decompose");
});

test("the readers reject a path-traversing run-id (`..`, separator, absolute) with a clear invalid-run-id error", () => {
  const { runsRoot } = makeStoredRun({ "mini-search-tuning": { spec: "# spec\n" } });

  const malicious = ["../../etc", "..", "a/b", "/etc", "x\\y", "."];
  for (const badId of malicious) {
    assert.throws(
      () => readRunConfig(runsRoot, badId),
      /invalid run-id/,
      `readRunConfig should reject ${JSON.stringify(badId)}`,
    );
    assert.throws(
      () => readRunInputs(runsRoot, badId),
      /invalid run-id/,
      `readRunInputs should reject ${JSON.stringify(badId)}`,
    );
    assert.throws(
      () => rescoreRun(runsRoot, badId),
      /invalid run-id/,
      `rescoreRun should reject ${JSON.stringify(badId)}`,
    );
  }
});

test("a normal `YYYYMMDD-HHMMSS-<rand4>` run-id is accepted (the guard rejects only traversal)", () => {
  // Build a stored run under a legitimately-formed id and confirm it reads back through the guard unharmed.
  const root = mkdtempSync(join(tmpdir(), "selfeval-read-ok-"));
  const runsRoot = join(root, "runs");
  const runId = "20260617-000000-ab12";
  const slugDir = join(runsRoot, runId, "tasks", "mini-search-tuning", "work", "mini-search-tuning");
  mkdirSync(slugDir, { recursive: true });
  const fixtureDir = join(root, "fixture");
  cpSync(MINI_FIXTURE, fixtureDir, { recursive: true });
  writeFileSync(join(slugDir, "spec.md"), "# spec\nok\n", "utf8");
  const config: RunConfig = { runId, kind: "routing", fixtureDir, startedAt: "2026-06-17T00:00:00.000Z" };
  writeFileSync(join(runsRoot, runId, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  assert.doesNotThrow(() => readRunConfig(runsRoot, runId));
  assert.equal(readRunConfig(runsRoot, runId).runId, runId);
  const inputs = readRunInputs(runsRoot, runId);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.taskId, "mini-search-tuning");
});
