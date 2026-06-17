// The unified self-eval CLI — the composition root (ADR-004 / T-F). A thin subcommand dispatcher that OWNS no
// probe logic: it constructs the persistence layer (`RunStore` + `EvalEmitter`), bundles them into the injected
// `EvalObserver`, and threads them into the existing routing/quality probes (reused via their public exports —
// never rewritten, AC5). Four subcommands replace the old throwaway `diag-*.ts` / `quality-gate.ts` scripts:
//
//   selfeval run routing  --fixture <dir> [--runs k] [--k k] [--plugin-dir p] [--runs-root d] [--run-id id]
//   selfeval run quality  [--from-run <id>] [--fixtures <dir>] [--k k] [--runs-root d]
//   selfeval trace        <taskId> --fixture <dir> [--plugin-dir p] [--runs-root d] [--run-id id]
//   selfeval replay       <id> [--runs-root d]
//
// stdout carries ONLY the run dir / artifact path (script-friendly); progress goes to stderr + the per-run
// `events.jsonl` via the emitter. Argument errors exit non-zero loudly (exit 2 for parse/usage, 1 for runtime).
//
// THE AC3 TOKEN-BLEED FIX lives in `run quality --from-run <id>`: it reconstructs the `QualityInput[]` from the
// STORED routing artifacts (`readRunInputs`) and judges those — NO live conductor re-run, so only the judge
// spends. Without `--from-run` it judges the planted fixtures as before.

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { newRunId } from "./store/runId.ts";
import { createRunStore, type RunStore } from "./store/write.ts";
import { createEmitter } from "./store/events.ts";
import { readRunConfig, readRunInputs, rescoreRun } from "./store/read.ts";
import { SCHEMA_VERSION, type EvalObserver, type RunConfig, type RunSummary } from "./store/schema.ts";

import { liveRunner } from "./io/live.ts";
import { runRoutingProbe } from "./routing/probe.ts";
import { loadRoutingFixture } from "./routing/fixture.ts";

import { runQualityProbe, type QualityInput } from "./quality/probe.ts";
import { realJudgeFn, type JudgeFn } from "./quality/judge.ts";
import { loadPlantedFixtures, resolveInputs } from "./quality/command.ts";

/**
 * The default runs-root, anchored to the SELFEVAL PACKAGE ROOT (`<selfeval>/runs`) — NOT to CWD. Computed from this
 * file's own location: `cli.ts` lives at `<selfeval>/src/cli.ts`, so the package root is one dir up from `src/`.
 * CWD-relative resolution was the bug — invoked from inside `selfeval/` it nested to `selfeval/selfeval/runs/`, which
 * the root `.gitignore` `selfeval/runs/` does not match, so run output escaped the ignore. An explicit `--runs-root`
 * still resolves relative to CWD (for tests / custom locations).
 */
const DEFAULT_RUNS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "runs");

/** A usage error — surfaced loudly and mapped to exit code 2 (a setup/argument bug, distinct from a runtime fault). */
class UsageError extends Error {}

/** Parsed flags shared across the subcommands (raw strings; each handler reads only the ones it needs). */
export interface CliFlags {
  fixture?: string;
  fixtures?: string;
  runs?: string;
  k?: string;
  pluginDir?: string;
  runsRoot?: string;
  runId?: string;
  fromRun?: string;
}

/** Map of `--flag` → CliFlags key. A flag absent here is an unknown flag → loud UsageError. */
const FLAGS: Record<string, keyof CliFlags> = {
  "--fixture": "fixture",
  "--fixtures": "fixtures",
  "--runs": "runs",
  "--k": "k",
  "--plugin-dir": "pluginDir",
  "--runs-root": "runsRoot",
  "--run-id": "runId",
  "--from-run": "fromRun",
};

/**
 * Split a subcommand's argv into its leading POSITIONAL tokens (e.g. a `<taskId>` / `<id>`) and its `--flag value`
 * pairs. Positionals must precede flags. An unknown flag or a value-less flag throws a {@link UsageError} (a typo
 * is a setup bug surfaced loudly, mirroring the per-probe `command.ts` parsers).
 */
function parseFlags(argv: readonly string[]): { positionals: string[]; flags: CliFlags } {
  const positionals: string[] = [];
  const flags: CliFlags = {};
  let i = 0;
  while (i < argv.length && !argv[i]!.startsWith("--")) {
    positionals.push(argv[i]!);
    i++;
  }
  for (; i < argv.length; i++) {
    const flag = argv[i]!;
    const key = FLAGS[flag];
    if (key === undefined) throw new UsageError(`selfeval: unknown flag "${flag}"`);
    const value = argv[i + 1];
    if (value === undefined) throw new UsageError(`selfeval: flag "${flag}" expects a value`);
    flags[key] = value;
    i++;
  }
  return { positionals, flags };
}

/**
 * Resolve the runs-root to an absolute path. Default = the package-root `<selfeval>/runs` (already absolute, so
 * `resolve` is a no-op and it's CWD-independent). An explicit `--runs-root` resolves relative to CWD as before.
 */
export function resolveRunsRoot(flags: CliFlags): string {
  return resolve(flags.runsRoot ?? DEFAULT_RUNS_ROOT);
}

/**
 * Construct the persistence layer for one run and bundle it into the injected {@link EvalObserver}. The store dir
 * is created (`beginRun` mkdirs it) so the emitter's `events.jsonl` has a parent to append to. Returns the store
 * (to call `finishRun` after the probe) and the run dir (echoed to stdout).
 */
function openRun(runsRoot: string, runId: string, config: RunConfig): { store: RunStore; runDir: string; observer: EvalObserver } {
  const runDir = join(runsRoot, runId);
  const store = createRunStore(runsRoot, runId);
  store.beginRun(config); // mkdirs runs/<id>/ + writes config.json — must precede the emitter's first append.
  const emitter = createEmitter(join(runDir, "events.jsonl"), (line) => process.stderr.write(line));
  const observer: EvalObserver = { emit: emitter.emit, onTaskComplete: store.captureTask };
  return { store, runDir, observer };
}

/** Wrap the probe's returned artifact in the run-level {@link RunSummary} the store persists verbatim. */
function summaryFor(config: RunConfig, taskCount: number, artifact: unknown): RunSummary {
  return {
    runId: config.runId,
    kind: config.kind,
    schemaVersion: SCHEMA_VERSION,
    config,
    taskCount,
    finishedAt: new Date().toISOString(),
    artifact,
  };
}

/**
 * `run routing` — drive the routing probe with full persistence into `runs/<id>/`. Constructs the run id (honoring
 * `--run-id`), the store + emitter (the observer), runs `runRoutingProbe` store-backed, and writes `summary.json`
 * from the probe's returned artifact. Echoes the run dir to stdout.
 */
async function runRouting(flags: CliFlags, runner = liveRunner): Promise<number> {
  if (flags.fixture === undefined) throw new UsageError("run routing: --fixture <dir> is required");
  const fixtureDir = resolve(flags.fixture);
  const runsRoot = resolveRunsRoot(flags);
  const runId = newRunId(flags.runId);
  const runs = flags.runs !== undefined ? Number(flags.runs) : 1;

  const config: RunConfig = {
    runId,
    kind: "routing",
    fixtureDir,
    ...(flags.k !== undefined ? { k: Number(flags.k) } : {}),
    runs,
    ...(flags.pluginDir !== undefined ? { pluginDir: resolve(flags.pluginDir) } : {}),
    startedAt: new Date().toISOString(),
  };
  const { store, runDir, observer } = openRun(runsRoot, runId, config);

  const result = await runRoutingProbe({
    fixtureDir,
    runner,
    outPath: join(runDir, "summary-artifact.json"), // the probe also writes its raw artifact here; summary.json wraps it.
    observer,
    runId,
    runs,
    ...(flags.k !== undefined ? { k: Number(flags.k) } : {}),
    ...(flags.pluginDir !== undefined ? { pluginDir: resolve(flags.pluginDir) } : {}),
  });

  store.finishRun(summaryFor(config, result.outcomes.length, result.artifact));
  process.stdout.write(`${runDir}\n`);
  return 0;
}

/**
 * `run quality` — judge artifacts and write a `decision-quality.json`. THE AC3 FIX: with `--from-run <id>`, the
 * inputs are reconstructed from the STORED routing run (`readRunInputs`) — no live conductor re-run, only the
 * judge spends. Without `--from-run`, the planted fixtures are judged (the self-contained smoke run). The judge
 * is injectable so a test drives zero-API; production uses the real `claude -p` judge.
 */
async function runQuality(flags: CliFlags, judge: JudgeFn = realJudgeFn): Promise<number> {
  if (flags.fixtures === undefined) throw new UsageError("run quality: --fixtures <dir> is required (the planted control ground truth)");
  const fixturesDir = resolve(flags.fixtures);
  const planted = loadPlantedFixtures(fixturesDir);

  let inputs: QualityInput[];
  let outPath: string;
  if (flags.fromRun !== undefined) {
    // AC3: reconstruct the judgeable inputs from the stored routing artifacts — zero conductor re-run. The reader
    // validates the raw run-id (path-confinement) before joining, so pass runsRoot + the raw id and build outPath
    // only after the read succeeds (a bad id is rejected by the reader first).
    const runsRoot = resolveRunsRoot(flags);
    inputs = readRunInputs(runsRoot, flags.fromRun);
    outPath = join(runsRoot, flags.fromRun, "decision-quality.json");
  } else {
    // No source run ⇒ judge the planted fixtures as the inputs (a self-contained smoke run), reusing the
    // quality command's own input resolver so the behavior matches the back-compat entrypoint.
    inputs = resolveInputs({}, planted);
    outPath = resolve("decision-quality.json");
  }

  const result = await runQualityProbe({
    artifacts: inputs,
    planted,
    judge,
    outPath,
    ...(flags.k !== undefined ? { k: Number(flags.k) } : {}),
  });

  process.stdout.write(`${result.outPath}\n`);
  return 0;
}

/**
 * `trace <taskId>` — run the routing probe over the fixture with full capture into a run dir, then echo the path
 * to the requested task's captured `tasks/<taskId>/` directory (its `stream.jsonl` + `work/` + shape/timing). The
 * durable replacement for the throwaway `diag-<task>.ts` scripts: a stored, inspectable single-task capture.
 *
 * NOTE: it runs the probe over the whole `--fixture` set (the routing package exposes no single-task entrypoint —
 * `runAndExtract` is internal), then surfaces the one task's stored artifacts. The `taskId` must exist in the
 * fixture; an unknown id is a loud usage error rather than a silent empty trace.
 */
async function trace(positionals: string[], flags: CliFlags, runner = liveRunner): Promise<number> {
  const taskId = positionals[0];
  if (taskId === undefined) throw new UsageError("trace: a <taskId> positional argument is required");
  if (flags.fixture === undefined) throw new UsageError("trace: --fixture <dir> is required");
  const fixtureDir = resolve(flags.fixture);

  // Fail loudly BEFORE running if the requested task isn't in the labeled set — a typo shouldn't burn a run.
  const labeled = loadRoutingFixture(join(fixtureDir, "tasks.yaml"));
  if (!labeled.some((t) => t.id === taskId)) {
    throw new UsageError(`trace: task "${taskId}" not found in ${join(fixtureDir, "tasks.yaml")}`);
  }

  const runsRoot = resolveRunsRoot(flags);
  const runId = newRunId(flags.runId);
  const config: RunConfig = {
    runId,
    kind: "routing",
    fixtureDir,
    runs: 1,
    ...(flags.pluginDir !== undefined ? { pluginDir: resolve(flags.pluginDir) } : {}),
    startedAt: new Date().toISOString(),
  };
  const { store, runDir, observer } = openRun(runsRoot, runId, config);

  const result = await runRoutingProbe({
    fixtureDir,
    runner,
    outPath: join(runDir, "summary-artifact.json"),
    observer,
    runId,
    runs: 1,
    ...(flags.pluginDir !== undefined ? { pluginDir: resolve(flags.pluginDir) } : {}),
  });
  store.finishRun(summaryFor(config, result.outcomes.length, result.artifact));

  // stdout = the path to the traced task's captured artifacts (single-run task ⇒ bare `tasks/<taskId>/`).
  process.stdout.write(`${join(runDir, "tasks", taskId)}\n`);
  return 0;
}

/**
 * `replay <id>` — offline re-analysis of a STORED run with ZERO API. Reads the run's config back and re-derives
 * each task's routing shape from the stored `work/` artifacts (`rescoreRun`), printing the re-derived shapes. No
 * runner, no judge, no live call — proof a persisted run is re-analyzable after the fact.
 */
function replay(positionals: string[], flags: CliFlags): number {
  const runId = positionals[0];
  if (runId === undefined) throw new UsageError("replay: a <id> positional argument is required");
  const runsRoot = resolveRunsRoot(flags);

  // The readers validate the raw run-id (path-confinement) before joining, so pass runsRoot + the raw id.
  const config = readRunConfig(runsRoot, runId); // throws loudly if the run dir / config.json is absent.
  const rescored = rescoreRun(runsRoot, runId);

  process.stderr.write(`replay ${config.runId} (kind=${config.kind}, ${rescored.length} task(s) re-derived offline)\n`);
  for (const { taskId, shape } of rescored) {
    process.stdout.write(`${taskId} → ${shape}\n`);
  }
  return 0;
}

/**
 * The subcommand dispatcher. Parses the leading subcommand token(s), hands the rest to the matching handler, and
 * maps thrown errors to exit codes: a {@link UsageError} → 2 (argument/usage), any other error → 1 (runtime).
 *
 * The injectable `runner`/`judge` are the zero-API test seams (a replay runner / a canned judge); production
 * leaves them defaulted to the live runner / real judge.
 */
export async function main(argv: readonly string[], deps: { runner?: typeof liveRunner; judge?: JudgeFn } = {}): Promise<number> {
  try {
    const [command, sub, ...rest] = argv;

    if (command === "run") {
      if (sub === "routing") {
        return await runRouting(parseFlags(rest).flags, deps.runner);
      }
      if (sub === "quality") {
        return await runQuality(parseFlags(rest).flags, deps.judge);
      }
      throw new UsageError(`selfeval: unknown "run" subcommand "${sub ?? ""}" (expected "routing" | "quality")`);
    }

    if (command === "trace") {
      const { positionals, flags } = parseFlags([sub, ...rest].filter((t): t is string => t !== undefined));
      return await trace(positionals, flags, deps.runner);
    }

    if (command === "replay") {
      const { positionals, flags } = parseFlags([sub, ...rest].filter((t): t is string => t !== undefined));
      return replay(positionals, flags);
    }

    throw new UsageError(
      `selfeval: unknown command "${command ?? ""}" (expected "run routing" | "run quality" | "trace <taskId>" | "replay <id>")`,
    );
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return err instanceof UsageError ? 2 : 1;
  }
}

// Entry point: run when invoked directly (`node --import tsx src/cli.ts ...`). No TTY prompt.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`selfeval crashed: ${String(err)}\n`);
      process.exit(1);
    },
  );
}
