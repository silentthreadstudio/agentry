// Tests for the unified self-eval CLI composition root (cli.ts / T-10) — the GENERIC dispatch + path-resolution +
// offline-replay + argument-error surfaces. ZERO live API by construction: the replay path is a pure fs read, and
// the argument-error cases never reach a conduct. The `run bench` conduct itself is covered end-to-end in
// `cli-bench.test.ts` (the injected fake-runner + canned-judge composition); this file owns the surfaces that are
// not bench-specific.
//
// The public subcommand set is exactly { run bench } over a live conduct, plus zero-API `replay <id>` /
// `report <id>`. The seam the conduct tests lean on: `main`'s second arg `{ runner, judge }` injects the zero-API
// impls; production leaves them defaulted to the live runner / real judge. A `--run-id` override pins a run dir.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { main, resolveRunsRoot } from "../src/cli.ts";
import type { RunConfig } from "../src/store/schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_MINI_DIR = join(HERE, "fixtures", "bench-mini");

/** A fresh temp runs-root so no test clobbers another's tree. */
function freshRunsRoot(): string {
  return mkdtempSync(join(tmpdir(), "selfeval-cli-runs-"));
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

// --- replay: offline re-analysis of a stored run, zero API ---------------------------------------------

/** Pre-seed a stored run on disk (config.json + a spec-bearing work tree) so replay can re-derive its shape offline. */
function seedStoredRun(runsRoot: string, runId: string, specs: Record<string, string>): void {
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const config: RunConfig = { runId, kind: "bench", fixtureDir: BENCH_MINI_DIR, startedAt: "2026-06-17T00:00:00.000Z" };
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
  seedStoredRun(runsRoot, "stored-run", { "bm-clamp": "# spec\n" });

  const code = await main(["replay", "stored-run", "--runs-root", runsRoot]);
  assert.equal(code, 0); // pure fs read, no injected deps needed — proves the offline path takes no live call.
});

// --- argument parsing errors exit non-zero loudly -----------------------------------------------------

test("an unknown command exits 2 (loud usage error)", async () => {
  assert.equal(await main(["frobnicate"]), 2);
});

test("an unknown run subcommand exits 2", async () => {
  assert.equal(await main(["run", "rightsizing", "--runs-root", freshRunsRoot()]), 2);
});

test("run bench without --fixtures-dir exits 2", async () => {
  assert.equal(await main(["run", "bench", "--runs-root", freshRunsRoot()]), 2);
});

test("an unknown flag exits 2", async () => {
  assert.equal(await main(["run", "bench", "--fixtures-dir", BENCH_MINI_DIR, "--bogus", "x"]), 2);
});

test("replay of a missing run dir exits 1 (runtime fault, not a usage error)", async () => {
  assert.equal(await main(["replay", "does-not-exist", "--runs-root", freshRunsRoot()]), 1);
});
