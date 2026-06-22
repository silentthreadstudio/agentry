// The R1 LIVE GATE entry (ADR-001 §R1, T-03 headline acceptance) — the riskiest-first validation that
// settle-then-extract is RELIABLE before the expensive full benchmark proceeds. It conducts ONE fully-dual
// fixture LIVE (`claude -p`), through the REAL judge, and asserts the two facets the unified probe depends on:
//   1. a NON-NULL routed `Shape` read from the SETTLED work folder (via `extractShape`), and
//   2. a JUDGEABLE `Score` over the produced tree (via `judgeWithRubric`).
// The single live `RunResult` is CAPTURED to a replay fixture so the zero-API suite can re-verify the
// settle-then-extract read offline thereafter (the suite stays API-free — the gate is the ONE live conduct).
//
// THIS SCRIPT IS THE GATED PAUSE POINT: it is NOT run by `pnpm test` (it spends API). The conductor runs it
// once, by hand, with the live runner + real judge. It prints the verdict + the captured replay path; a
// non-null shape AND a judgeable score is the GREEN R1 gate. If the read is unreliable (a null shape, or no
// judgeable result), STOP and route to research before Phase D (ADR-001 §R1).
//
// Usage (the EXACT command the conductor runs — see the banner printed on `--help` / no args):
//   node --import tsx src/rightsizing/r1-validate.ts --plugin-dir <repo-root> --fixture rs-clamp --model sonnet
//
// Composition only — it imports the SAME `runRightsizingProbe` the full bench uses, wrapping the live runner
// with a thin capture decorator so the single conduct's `RunResult` (its settle signals + work-folder layout +
// cost) lands as a replay fixture. No probe logic is duplicated here.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { liveRunner } from "../io/live.ts";
import type { Invocation, RunResult, Runner, Sandbox } from "../io/port.ts";
import { realJudgeFn } from "../judge/index.ts";

import { runRightsizingProbe } from "./probe.ts";

/** The package root (`<eval>/`), resolved from this file at `<eval>/src/rightsizing/r1-validate.ts`. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The dual-fixture corpus the probe loads (`<eval>/fixtures/rightsizing/`). */
const RS_FIXTURES = join(PKG_ROOT, "fixtures", "rightsizing");

/**
 * Where the captured replay lands — a sibling of the dual-fixture corpus, NOT under `fixtures/rightsizing/`
 * itself. The dual-fixture loader (`loadRightsizingFixture`) scans EVERY subdir of `fixtures/rightsizing/` and
 * requires each to be a valid `RightsizingFixture` (it throws on a `fixture.yaml`-less dir), so a captured
 * replay (a recorded `RunResult`, not a fixture) must live OUTSIDE that scan or it would break the loader — and
 * with it the whole zero-API suite. This sibling path keeps the capture addressable without poisoning the load.
 */
const R1_REPLAY_DIR = join(PKG_ROOT, "fixtures", "rightsizing-r1-replay");

/** The default conduct model (`--model`); sonnet keeps the live spend modest while exercising the real build. */
const DEFAULT_MODEL = "sonnet";

/** The default fully-dual fixture to conduct (a real `RightsizingFixture` id under `fixtures/rightsizing/`). */
const DEFAULT_FIXTURE = "rs-clamp";

interface R1Flags {
  pluginDir?: string;
  fixture: string;
  model: string;
}

/** The usage banner — printed on `--help` / no `--plugin-dir`, carrying the EXACT command the conductor runs. */
function usage(): string {
  return [
    "R1 LIVE GATE — validate settle-then-extract before the expensive bench (ADR-001 §R1).",
    "",
    "  node --import tsx src/rightsizing/r1-validate.ts \\",
    `    --plugin-dir <repo-root> --fixture ${DEFAULT_FIXTURE} --model ${DEFAULT_MODEL}`,
    "",
    "  --plugin-dir <repo-root>  REQUIRED — the Agentry plugin root (the repo root holding plugin/).",
    `  --fixture <id>            the dual fixture to conduct (default ${DEFAULT_FIXTURE}).`,
    `  --model <id>              the conduct model (default ${DEFAULT_MODEL}).`,
    "",
    "GREEN gate = a NON-NULL routed shape AND a judgeable score. It spends API — it is the ONE live conduct,",
    "captured to a replay fixture so the suite stays API-free. Not run by `pnpm test`.",
  ].join("\n");
}

/** Parse the small flag set; `--plugin-dir` is required (a live conduct without the plugin is meaningless). */
function parseArgs(argv: readonly string[]): R1Flags {
  const flags: R1Flags = { fixture: DEFAULT_FIXTURE, model: DEFAULT_MODEL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--help" || a === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else if (a === "--plugin-dir" && v !== undefined) {
      flags.pluginDir = v;
      i++;
    } else if (a === "--fixture" && v !== undefined) {
      flags.fixture = v;
      i++;
    } else if (a === "--model" && v !== undefined) {
      flags.model = v;
      i++;
    } else {
      throw new Error(`r1-validate: unknown or value-less flag "${a}"`);
    }
  }
  return flags;
}

/**
 * Wrap a `Runner` so the SINGLE conduct's `RunResult` + the produced work-folder layout are captured for replay.
 * The wrapper snapshots, after the live `run`, the `.agentry/work/*` artifacts the conductor left (the routed-
 * shape facet) into the `RunResult.workFolder` map the replay runner re-materializes — so the captured replay
 * reproduces the same `extractShape` read offline. It does NOT alter the run; it only records it.
 */
function capturingRunner(inner: Runner, capture: { result?: RunResult }): Runner {
  return {
    async run(invocation: Invocation, sandbox: Sandbox): Promise<RunResult> {
      const result = await inner.run(invocation, sandbox);
      const workFolder = snapshotWorkFolder(sandbox.workingDir);
      capture.result = { ...result, ...(workFolder !== undefined ? { workFolder } : {}) };
      return result;
    },
  };
}

/**
 * Snapshot the conductor's `.agentry/work/*` artifacts (the routed-shape signal) as a `RunResult.workFolder`
 * map (`.agentry/`-relative path → content), EXCLUDING the primer hook's own `events.jsonl` bookkeeping (the
 * same exclusion `producedTreeNonEmpty` encodes — a primer log is not a routing artifact). Returns `undefined`
 * when no work folder exists (the one-shot / degenerate path), matching the replay runner's "no artifacts" case.
 */
function snapshotWorkFolder(workingDir: string): Record<string, string> | undefined {
  const workRoot = join(workingDir, ".agentry", "work");
  const out: Record<string, string> = {};
  if (!existsSync(workRoot) || !statSync(workRoot).isDirectory()) return undefined;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry !== "events.jsonl") {
        // Key relative to `.agentry/` so the replay runner re-plants it under `<sandbox>/.agentry/<key>`.
        const rel = relative(join(workingDir, ".agentry"), abs).split(sep).join("/");
        out[rel] = readFileSync(abs, "utf8");
      }
    }
  };
  walk(workRoot);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Write the captured `RunResult` as a replay fixture (a single recorded run the replay runner re-drives). */
function writeReplayFixture(result: RunResult, fixtureId: string): string {
  mkdirSync(R1_REPLAY_DIR, { recursive: true });
  const path = join(R1_REPLAY_DIR, `${fixtureId}.run.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return path;
}

/** Drive the R1 live gate: ONE conduct over one dual fixture, capture the run, assert both facets, report. */
async function main(argv: readonly string[]): Promise<number> {
  const flags = parseArgs(argv);
  if (flags.pluginDir === undefined) {
    process.stderr.write(`${usage()}\n\nr1-validate: --plugin-dir <repo-root> is required.\n`);
    return 2;
  }

  const capture: { result?: RunResult } = {};
  const out = mkdtempSync(join(tmpdir(), "r1-validate-out-"));
  process.stderr.write(
    `R1 LIVE GATE: conducting fixture "${flags.fixture}" live (model=${flags.model}) — this spends API…\n`,
  );

  try {
    const { artifact, records } = await runRightsizingProbe({
      fixturesDir: RS_FIXTURES,
      fixtureFilter: flags.fixture,
      runner: capturingRunner(liveRunner, capture),
      judge: realJudgeFn,
      pluginDir: flags.pluginDir,
      model: flags.model,
      outPath: join(out, "r1-artifact.json"),
      k: 1,
    });

    // The R1 gate's two facets: a non-null routed shape AND a judgeable score over the produced tree.
    const record = records[0];
    if (artifact.condition === "aborted") {
      process.stderr.write(`R1 RED: controls aborted (${artifact.abortVerdict}) — no conduct ran.\n`);
      return 1;
    }
    if (record === undefined) {
      process.stderr.write("R1 RED: no per-run record was emitted.\n");
      return 1;
    }

    const shapeOk = record.shape !== undefined; // a DegenerateRunError ⇒ undefined ⇒ settle-then-extract failed
    const scoreOk = record.result !== undefined && Number.isFinite(record.result.overall);

    let replayPath = "(not captured)";
    if (capture.result !== undefined) replayPath = writeReplayFixture(capture.result, flags.fixture);

    process.stdout.write(
      [
        `R1 ${shapeOk && scoreOk ? "GREEN" : "RED"} — fixture ${flags.fixture}`,
        `  routed shape : ${record.shape ?? "<null — DegenerateRunError, settle-then-extract UNRELIABLE>"}`,
        `  judged score : ${scoreOk ? record.result!.overall.toFixed(2) : "<none — no judgeable result>"}`,
        `  replay fixture: ${replayPath}`,
        "",
      ].join("\n"),
    );

    if (!shapeOk || !scoreOk) {
      process.stderr.write("R1 RED: settle-then-extract is unreliable — STOP and route to research before Phase D.\n");
      return 1;
    }
    return 0;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// Entry point: run when invoked directly (`node --import tsx src/rightsizing/r1-validate.ts ...`).
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`r1-validate crashed: ${String(err)}\n`);
      process.exit(1);
    },
  );
}
