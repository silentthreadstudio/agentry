// Tests for the READ side of the artifact store (read.ts / T-E). Pure fs, ZERO API spend by construction: every
// test builds a fake `runs/<id>/` tree on disk (a `config.json` pointing at a tiny temp fixture dir + stored
// `tasks/<id>/work/<slug>/spec.md` files), then drives `readRunConfig`/`rescoreRun` and asserts they reconstruct
// the config / shape from disk WITHOUT any live call.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { readRunConfig, rescoreRun } from "../src/store/read.ts";
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
  // And the same legitimately-formed run is re-scorable offline through the guard unharmed.
  const rescored = rescoreRun(runsRoot, runId);
  assert.equal(rescored.length, 1);
  assert.equal(rescored[0]!.taskId, "mini-search-tuning");
});
