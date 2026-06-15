// Tests for the ORCHESTRATOR / CLI (T-010, M8) — the integration finisher. ZERO API spend: every test drives
// the full pipeline through a REPLAY/spy Runner; `claude -p` is never invoked. Covers the task's Acceptance:
//   #1 (AC1)  — the documented run drives end-to-end against a replay Runner, exits 0, writes scoreboard.json.
//   #2 (AC2/3/7) — the artifact carries C1–C4 {verdict,delta,variance} + per-regime table + R3 section.
//   #3 (AC9)  — two same-config+seed replay runs produce identical C1–C4 verdicts (re-read from disk).
//   #5 (AC12) — the per-run path calls assertEmptyRoots for A/B and restoreWarmSnapshot for C.
//   + config defaults (N=10) and the CLI arg/runner wiring.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { RunRecord } from "../src/types.ts";
import type { Invocation, Runner, Sandbox } from "../src/runner/port.ts";
import { resolveConfig, DEFAULT_N, DEFAULT_SEED } from "../src/config.ts";
import { runBenchmark, readScoreboard } from "../src/orchestrator.ts";
import { countMemoryRecords } from "../src/arms/isolation.ts";
import { parseArgs, configFromArgs, selectRunner } from "../src/cli.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = join(HERE, "..", "fixtures");

/** A RunRecord that leaves the roots empty (so A/B assertEmptyRoots passes). `producedTree` is recorded only. */
function emptyRecord(): RunRecord {
  return {
    cost: {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadInputTokens: 2000,
      cacheCreationInputTokens: 500,
      numTurns: 2,
      totalCostUsd: 0.1,
      durationMs: 5000,
    },
    producedTree: [],
    usedMemories: [],
    raw: { note: "test replay record" },
  };
}

/** A Runner that returns a fixed empty record for every run — deterministic, zero spend, roots untouched. */
function fixedRunner(record: RunRecord = emptyRecord()): Runner {
  return {
    run(_invocation: Invocation, _sandbox: Sandbox): Promise<RunRecord> {
      return Promise.resolve(structuredClone(record));
    },
  };
}

/** A fresh temp output dir; the caller removes it. */
function tmpOut(): string {
  return mkdtempSync(join(tmpdir(), "agentry-bench-out-"));
}

// --- #1 (AC1) + #2 (AC2/3/7): end-to-end → exit 0 → artifact with C1–C4 + per-regime + R3 -------------

test("runBenchmark drives end-to-end against a replay Runner and writes scoreboard.json (AC1)", async () => {
  const out = tmpOut();
  try {
    const jsonPath = join(out, "scoreboard.json");
    const result = await runBenchmark({
      config: resolveConfig({ suitePath: SUITE, arms: ["A", "B", "C"], n: 2, seed: 7 }),
      runner: fixedRunner(),
      jsonPath,
    });
    assert.ok(existsSync(jsonPath), "scoreboard.json must be written to disk");
    assert.equal(result.jsonPath, jsonPath);
    assert.equal(result.plannedCalls, 14 * 2, "planned calls = cells × N"); // 14 eligible cells in the suite
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the written artifact carries C1–C4 {verdict,delta,variance}, a per-regime table, R3, and r2Coverage (AC2/3/7/15)", async () => {
  const out = tmpOut();
  try {
    const jsonPath = join(out, "scoreboard.json");
    await runBenchmark({
      config: resolveConfig({ suitePath: SUITE, arms: ["A", "B", "C"], n: 2, seed: 7 }),
      runner: fixedRunner(),
      jsonPath,
    });
    // Re-read as ScoreboardArtifact (NOT the narrower Scoreboard) so r2Coverage survives the round-trip (AC15).
    const sb = readScoreboard(jsonPath);

    for (const key of ["c1", "c2", "c3", "c4"] as const) {
      assert.equal(typeof sb.claims[key].verdict, "string", `${key} verdict`);
      assert.equal(typeof sb.claims[key].delta, "number", `${key} delta`);
      assert.equal(typeof sb.claims[key].variance, "number", `${key} variance`);
    }
    // Per-regime table spans every regime present in the suite (AC3).
    assert.deepEqual(
      sb.perRegime.map((r) => r.regime),
      ["R0", "R1", "R1prime", "R2", "R3"],
    );
    // R3 section names the follow-up the moat is measured on (AC7).
    assert.equal(sb.r3.length, 1);
    assert.equal(sb.r3[0]!.followUpTaskId, "r3-followup-logger");
    // R2 coverage is a count per arm (AC15), present on the on-disk artifact.
    assert.equal(typeof sb.r2Coverage.A?.total, "number");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the R3 per-regime row reports tokens and turns per arm (AC3)", async () => {
  const out = tmpOut();
  try {
    const jsonPath = join(out, "scoreboard.json");
    await runBenchmark({
      config: resolveConfig({ suitePath: SUITE, arms: ["A", "B", "C"], n: 2, seed: 7 }),
      runner: fixedRunner(),
      jsonPath,
    });
    const sb = readScoreboard(jsonPath);
    const r3 = sb.perRegime.find((r) => r.regime === "R3")!;
    assert.ok(r3.tokensByArm?.B !== undefined, "R3 row must carry tokens per arm");
    assert.ok(r3.turnsByArm?.C !== undefined, "R3 row must carry turns per arm");
    const r0 = sb.perRegime.find((r) => r.regime === "R0")!;
    assert.equal(r0.tokensByArm, undefined, "non-R3 regimes omit tokens");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// --- #1 (AC1): optional Markdown projection on disk ---------------------------------------------------

test("when a markdown path is given, the projection is also written (AC1 optional .md)", async () => {
  const out = tmpOut();
  try {
    const jsonPath = join(out, "scoreboard.json");
    const mdPath = join(out, "scoreboard.md");
    const result = await runBenchmark({
      config: resolveConfig({ suitePath: SUITE, arms: ["B", "C"], n: 2, seed: 1 }),
      runner: fixedRunner(),
      jsonPath,
      markdownPath: mdPath,
    });
    assert.ok(existsSync(mdPath), "scoreboard.md must be written when requested");
    assert.equal(result.markdownPath, mdPath);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// --- #3 (AC9): two same-config+seed replay runs → identical C1–C4 verdicts ----------------------------

test("two same-config+seed replay runs produce identical C1–C4 verdicts re-read from disk (AC9)", async () => {
  const out = tmpOut();
  try {
    const cfg = () => resolveConfig({ suitePath: SUITE, arms: ["A", "B", "C"], n: 3, seed: 42 });
    const a = join(out, "a.json");
    const b = join(out, "b.json");
    await runBenchmark({ config: cfg(), runner: fixedRunner(), jsonPath: a });
    await runBenchmark({ config: cfg(), runner: fixedRunner(), jsonPath: b });
    const sbA = readScoreboard(a);
    const sbB = readScoreboard(b);
    for (const key of ["c1", "c2", "c3", "c4"] as const) {
      assert.equal(sbA.claims[key].verdict, sbB.claims[key].verdict, `${key} verdict must match`);
      assert.equal(sbA.claims[key].delta, sbB.claims[key].delta, `${key} delta must match`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// --- #5 (AC12): per-run isolation enforcement (assertEmptyRoots A/B, restoreWarmSnapshot C) ------------

test("arm C is snapshot-restored BEFORE the run — the runner observes the seeded roots (AC12 warm)", async () => {
  const out = tmpOut();
  try {
    let warmRecordsAtRunTime = -1;
    const observingRunner: Runner = {
      run(_inv: Invocation, sandbox: Sandbox): Promise<RunRecord> {
        // For arm C the warm snapshot must already be in the roots when the run executes (restore ran first).
        warmRecordsAtRunTime = countMemoryRecords(sandbox.globalRoot);
        return Promise.resolve(emptyRecord());
      },
    };
    await runBenchmark({
      // Run R3 arm C only so the observed count is the warm snapshot's (the global snapshot has 1 record).
      config: resolveConfig({ suitePath: SUITE, arms: ["C"], n: 1, seed: 1 }),
      runner: observingRunner,
      jsonPath: join(out, "sb.json"),
    });
    assert.ok(warmRecordsAtRunTime > 0, "arm C run must see the restored warm snapshot in its roots");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("assertEmptyRoots runs AFTER the run for arms A/B — a leaked record makes the run throw (AC12 cold/plain)", async () => {
  const out = tmpOut();
  try {
    // A malicious runner that writes a memory record into the (supposedly empty) roots. The orchestrator's
    // post-run assertEmptyRoots must catch it and throw — proving the assertion is wired into the per-run path.
    const leakingRunner: Runner = {
      run(_inv: Invocation, sandbox: Sandbox): Promise<RunRecord> {
        const factsDir = join(sandbox.globalRoot, "facts");
        mkdirSync(factsDir, { recursive: true });
        writeFileSync(join(factsDir, "leaked-01.md"), "leaked record");
        return Promise.resolve(emptyRecord());
      },
    };
    await assert.rejects(
      runBenchmark({
        config: resolveConfig({ suitePath: SUITE, arms: ["B"], n: 1, seed: 1 }),
        runner: leakingRunner,
        jsonPath: join(out, "sb.json"),
      }),
      /AC12 violated/,
      "a non-empty cold root after the run must fail assertEmptyRoots",
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// --- config defaults (N=10, user decision) -----------------------------------------------------------

test("resolveConfig defaults N to 10 and seed to its default (user decision)", () => {
  const cfg = resolveConfig({ suitePath: SUITE });
  assert.equal(cfg.n, DEFAULT_N);
  assert.equal(cfg.n, 10);
  assert.equal(cfg.seed, DEFAULT_SEED);
  assert.deepEqual(cfg.arms, ["A", "B", "C"]);
});

test("resolveConfig rejects an empty arms list and a non-positive n", () => {
  assert.throws(() => resolveConfig({ suitePath: SUITE, arms: [] }), /non-empty/);
  assert.throws(() => resolveConfig({ suitePath: SUITE, n: 0 }), /positive integer/);
});

test("resolveConfig dedupes and canonicalizes arm order (deterministic matrix)", () => {
  const cfg = resolveConfig({ suitePath: SUITE, arms: ["C", "A", "C"] });
  assert.deepEqual(cfg.arms, ["A", "C"]);
});

// --- CLI arg parsing + runner selection --------------------------------------------------------------

test("parseArgs + configFromArgs build a config from the documented flags", () => {
  const args = parseArgs(["--suite", SUITE, "--arms", "A,B", "--n", "4", "--seed", "9"]);
  const cfg = configFromArgs(args);
  assert.deepEqual(cfg.arms, ["A", "B"]);
  assert.equal(cfg.n, 4);
  assert.equal(cfg.seed, 9);
});

test("parseArgs rejects an unknown flag", () => {
  assert.throws(() => parseArgs(["--nope", "x"]), /unknown flag/);
});

test("selectRunner returns a zero-spend replay runner when --runner replay has no fixture", async () => {
  const runner = selectRunner(parseArgs(["--runner", "replay"]));
  const record = await runner.run(
    { prompt: "x", model: "m" },
    { workingDir: "/tmp", globalRoot: "/tmp/g", projectRoot: "/tmp/p", env: {} },
  );
  assert.deepEqual(record.producedTree, [], "the smoke replay runner returns an empty produced tree");
});

test("selectRunner rejects an invalid --runner value", () => {
  assert.throws(() => selectRunner(parseArgs(["--runner", "bogus"])), /must be "live" or "replay"/);
});
