// The unified self-eval CLI — the composition root (ADR-002 / T-10). A thin subcommand dispatcher that OWNS no
// probe logic: it constructs the persistence layer (`RunStore` + `EvalEmitter`), bundles them into the injected
// `EvalObserver`, and threads them into the BENCH probe — reused via its public export, never rewritten.
//
// The public subcommand set is exactly { bench } over a live conduct, plus the zero-API `replay <id>` /
// `report <id>` over a stored run. The bench conducts Agentry ONCE per fixture and derives ALL FOUR value axes
// (decision · code+correctness · honesty/overclaim · verification) from that single run, writing its artifact into
// the run's `summary.json` — there is no separate honesty rider.
//
// stdout carries ONLY the run dir / artifact path (script-friendly); progress goes to stderr + the per-run
// `events.jsonl` via the emitter. Argument errors exit non-zero loudly (exit 2 for parse/usage, 1 for runtime).

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { newRunId } from "./store/runId.ts";
import { createRunStore, type RunStore } from "./store/write.ts";
import { createEmitter } from "./store/events.ts";
import { readRunConfig, rescoreRun } from "./store/read.ts";
import { SCHEMA_VERSION, type EvalObserver, type RunConfig, type RunSummary } from "./store/schema.ts";

import { liveRunner } from "./io/live.ts";
import { realJudgeFn, DEFAULT_JUDGE_MODEL, type JudgeFn } from "./judge/index.ts";

import { runBenchProbe } from "./bench/probe.ts";

import { emitReport } from "./report/emit.ts";

/**
 * The default runs-root, anchored to the SELFEVAL PACKAGE ROOT (`<selfeval>/runs`) — NOT to CWD. Computed from this
 * file's own location: `cli.ts` lives at `<selfeval>/src/cli.ts`, so the package root is one dir up from `src/`.
 * CWD-relative resolution was the bug — invoked from inside `selfeval/` it nested to `selfeval/selfeval/runs/`, which
 * the root `.gitignore` `selfeval/runs/` does not match, so run output escaped the ignore. An explicit `--runs-root`
 * still resolves relative to CWD (for tests / custom locations).
 */
const DEFAULT_RUNS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "runs");

/** The committed report-output root (`<selfeval>/results`) and the curated corrections file, both package-anchored. */
const DEFAULT_RESULTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "results");
const DEFAULT_CORRECTIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "corrections.json");

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
  resultsRoot?: string;
  correctionsPath?: string;
  /** bench only — the fixtures dir (one `<id>/` subdir per bench fixture). */
  fixturesDir?: string;
  /** bench only — model id pinned per CONDUCT run. */
  model?: string;
  /** bench only — per-run hard ceiling (ms). */
  timeout?: string;
  /** bench only — bounded conduct concurrency (default 1 = serial). */
  concurrency?: string;
  /** bench only — model id pinned for every JUDGE call (defaults to {@link DEFAULT_JUDGE_MODEL}). */
  judgeModel?: string;
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
  "--results-root": "resultsRoot",
  "--corrections": "correctionsPath",
  "--fixtures-dir": "fixturesDir",
  "--model": "model",
  "--timeout": "timeout",
  "--concurrency": "concurrency",
  "--judge-model": "judgeModel",
};

/**
 * Split a subcommand's argv into its leading POSITIONAL tokens (e.g. an `<id>`) and its `--flag value` pairs.
 * Positionals must precede flags. An unknown flag or a value-less flag throws a {@link UsageError} (a typo is a
 * setup bug surfaced loudly, mirroring the per-probe parsers).
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
 * is created (`beginRun` mkdirs it) so the emitter's `events.jsonl` has a parent to append to.
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
 * `run bench` — drive the conduct-once → FOUR-axis value bench (the reshape plan) ONCE with full persistence into
 * `runs/<id>/` (require `--fixtures-dir`; open the run; thread the filters/knobs into the probe; wrap the returned
 * artifact into `summary.json`; echo the run dir). The bench probe owns ALL four axes from the one conduct.
 *
 * The JUDGE is injectable (a canned content-keyed fn in tests = zero API; the real `claude -p` judge in production),
 * pinned to one judge model (`--judge-model`, default {@link DEFAULT_JUDGE_MODEL}). `--fixture` restricts the matrix
 * to one fixture; `--runs`/`--k` set the repeat count k (default 1); `--concurrency` bounds matrix parallelism
 * (default 1 = serial). The Axis-A decision controls default to `<fixturesDir>/_controls/` (the probe SKIPS that gate
 * when the dir is absent, so the bench runs before those controls are authored).
 */
async function runBench(flags: CliFlags, runner = liveRunner, judge: JudgeFn = realJudgeFn): Promise<number> {
  const fixturesDirRaw = flags.fixturesDir ?? flags.fixtures;
  if (fixturesDirRaw === undefined) throw new UsageError("run bench: --fixtures-dir <dir> is required");
  const fixturesDir = resolve(fixturesDirRaw);
  const runsRoot = resolveRunsRoot(flags);
  const runId = newRunId(flags.runId);
  const k = flags.k !== undefined ? Number(flags.k) : flags.runs !== undefined ? Number(flags.runs) : 1;
  const judgeModel = flags.judgeModel ?? DEFAULT_JUDGE_MODEL;

  const config: RunConfig = {
    runId,
    kind: "bench",
    fixtureDir: fixturesDir,
    k,
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    ...(flags.pluginDir !== undefined ? { pluginDir: resolve(flags.pluginDir) } : {}),
    startedAt: new Date().toISOString(),
  };
  const { store, runDir, observer } = openRun(runsRoot, runId, config);

  const result = await runBenchProbe({
    fixturesDir,
    runner,
    judge,
    judgeModel,
    decisionControlsDir: join(fixturesDir, "_controls"),
    outPath: join(runDir, "summary-artifact.json"), // the probe also writes its raw artifact here; summary.json wraps it.
    observer,
    runId,
    k,
    ...(flags.fixture !== undefined ? { fixtureFilter: flags.fixture } : {}),
    ...(flags.concurrency !== undefined ? { concurrency: Number(flags.concurrency) } : {}),
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    ...(flags.timeout !== undefined ? { timeoutMs: Number(flags.timeout) } : {}),
    ...(flags.pluginDir !== undefined ? { pluginDir: resolve(flags.pluginDir) } : {}),
  });

  store.finishRun(summaryFor(config, result.records.length, result.artifact));

  process.stdout.write(`${runDir}\n`);
  return 0;
}

/**
 * `replay <id>` — offline re-analysis of a STORED run with ZERO API. Re-derives each task's routing shape from
 * the stored `work/` artifacts (`rescoreRun`) — proof a persisted run is re-analyzable after the fact.
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
 * `report <id>` — generate the static dashboard for a STORED run with ZERO live API (doc 08 §6). Reads the run's
 * stored artifacts + the curated corrections file + the run-history index, and writes a self-contained
 * `results/<date>/<id>/index.html`. Echoes the written path.
 */
function report(positionals: string[], flags: CliFlags): number {
  const runId = positionals[0];
  if (runId === undefined) throw new UsageError("report: a <id> positional argument is required");
  const runsRoot = resolveRunsRoot(flags);
  const resultsRoot = flags.resultsRoot !== undefined ? resolve(flags.resultsRoot) : DEFAULT_RESULTS_ROOT;
  const correctionsPath = flags.correctionsPath !== undefined ? resolve(flags.correctionsPath) : DEFAULT_CORRECTIONS;

  const { outPath } = emitReport(runsRoot, runId, { resultsRoot, correctionsPath });
  process.stdout.write(`${outPath}\n`);
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
      if (sub === "bench") {
        return await runBench(parseFlags(rest).flags, deps.runner, deps.judge);
      }
      throw new UsageError(`selfeval: unknown "run" subcommand "${sub ?? ""}" (expected "bench")`);
    }

    if (command === "replay") {
      const { positionals, flags } = parseFlags([sub, ...rest].filter((t): t is string => t !== undefined));
      return replay(positionals, flags);
    }

    if (command === "report") {
      const { positionals, flags } = parseFlags([sub, ...rest].filter((t): t is string => t !== undefined));
      return report(positionals, flags);
    }

    throw new UsageError(
      `selfeval: unknown command "${command ?? ""}" (expected "run bench" | "replay <id>" | "report <id>")`,
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
