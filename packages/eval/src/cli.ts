// The unified self-eval CLI — the composition root (ADR-002 / T-10). A thin subcommand dispatcher that OWNS no
// probe logic: it constructs the persistence layer (`RunStore` + `EvalEmitter`), bundles them into the injected
// `EvalObserver`, and threads them into the three PUBLIC probes (Moat · Right-sizing · Honesty) — reused via their
// public exports, never rewritten.
//
// The public subcommand set is exactly { moat, rightsizing } over a live conduct, plus the zero-API `replay <id>` /
// `report <id>` over a stored run. The HONESTY probe is NOT a standalone conduct: it rides the SAME conduct as
// right-sizing (one unified conduct = one run dir, ADR-001). So `run rightsizing` drives the conduct ONCE, scores
// the right-sizing artifact into `summary.json`, AND runs the (pure, no-reconduct) honesty probe over the SAME
// records, writing its artifact as a sibling `honesty.json` in that run dir — exactly where T-08's report reader
// (`report/honesty.ts`) looks for it. The decision-quality (`quality/`) probe is PARKED off the public set (ADR-002):
// its code + tests stay, but it has no public subcommand and no report section.
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
import { agentryCell, type Cell } from "./conduct/cell.ts";

import { runRightsizingProbe } from "./rightsizing/probe.ts";
import { runHonestyProbe } from "./honesty/probe.ts";
import { runMoatProbe } from "./moat/probe.ts";

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

/** The sibling filename the honesty artifact is written under, INSIDE the unified rightsizing run dir (T-08 read contract). */
const HONESTY_FILE = "honesty.json";

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
  /** rightsizing only — the fixtures dir (one `<id>/` subdir per rightsizing fixture). */
  fixturesDir?: string;
  /** rightsizing only — restrict the matrix to one cell (`agentry`; the bare baseline is retired — ADR-003). */
  cell?: string;
  /** rightsizing only — model id pinned per CONDUCT run. */
  model?: string;
  /** rightsizing only — per-run hard ceiling (ms). */
  timeout?: string;
  /** rightsizing only — bounded matrix concurrency (default 1 = serial). */
  concurrency?: string;
  /** rightsizing only — model id pinned for every JUDGE call (defaults to {@link DEFAULT_JUDGE_MODEL}). */
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
  "--cell": "cell",
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
 * `run rightsizing` — drive the UNIFIED conduct-and-judge probe (ADR-001) ONCE with full persistence into
 * `runs/<id>/`, then run the (pure, no-reconduct) HONESTY probe over the SAME records and write its artifact as a
 * sibling `honesty.json` in that SAME run dir (the T-08 read contract: one unified conduct = one run dir, with the
 * rightsizing artifact in `summary.json` and the honesty artifact beside it). Echoes the run dir.
 *
 * The rightsizing probe runs the controls-first gate (judge-tokens only), and on a control abort emits an ABORTED
 * artifact with NO records — the honesty probe is then driven with that same `abortVerdict` so its sibling artifact
 * is correspondingly aborted (NO numbers), keeping the two halves of the one conduct consistent.
 *
 * `--cell`/`--fixture`/`--runs` are the matrix-cost slice filters (the de-risk run pins one fixture × k=1).
 * `--concurrency` bounds matrix parallelism (default 1 = serial). The JUDGE is injectable (a canned fn in tests =
 * zero API; the real `claude -p` judge in production), pinned to one judge model (`--judge-model`).
 */
async function runRightsizing(flags: CliFlags, runner = liveRunner, judge: JudgeFn = realJudgeFn): Promise<number> {
  const fixturesDirRaw = flags.fixturesDir ?? flags.fixtures;
  if (fixturesDirRaw === undefined) throw new UsageError("run rightsizing: --fixtures-dir <dir> is required");
  const fixturesDir = resolve(fixturesDirRaw);
  const cells = cellsFromFlag(flags.cell, flags.model);
  const runsRoot = resolveRunsRoot(flags);
  const runId = newRunId(flags.runId);
  const k = flags.runs !== undefined ? Number(flags.runs) : 1;
  const judgeModel = flags.judgeModel ?? DEFAULT_JUDGE_MODEL;

  const config: RunConfig = {
    runId,
    kind: "rightsizing",
    fixtureDir: fixturesDir,
    k,
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    ...(flags.pluginDir !== undefined ? { pluginDir: resolve(flags.pluginDir) } : {}),
    startedAt: new Date().toISOString(),
  };
  const { store, runDir, observer } = openRun(runsRoot, runId, config);

  const result = await runRightsizingProbe({
    fixturesDir,
    runner,
    judge,
    judgeModel,
    outPath: join(runDir, "summary-artifact.json"), // the probe also writes its raw artifact here; summary.json wraps it.
    observer,
    runId,
    k,
    ...(cells !== undefined ? { cell: cells[0] } : {}),
    ...(flags.fixture !== undefined ? { fixtureFilter: flags.fixture } : {}),
    ...(flags.concurrency !== undefined ? { concurrency: Number(flags.concurrency) } : {}),
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    ...(flags.timeout !== undefined ? { timeoutMs: Number(flags.timeout) } : {}),
    ...(flags.pluginDir !== undefined ? { pluginDir: resolve(flags.pluginDir) } : {}),
  });

  store.finishRun(summaryFor(config, result.records.length, result.artifact));

  // HONESTY rides the SAME conduct (ADR-001): score the pure overclaim-gap over the SAME records (no re-conduct),
  // writing the artifact beside the rightsizing summary as `honesty.json`. When the conduct's controls aborted the
  // batch, thread the abort verdict through so the honesty artifact is correspondingly aborted (NO numbers). The
  // unified conduct persists no escalated run dirs, so flow-compliance has no targets here — overclaim is the half
  // a unified conduct emits; the flow-compliance census is fed separately by escalated conducts.
  runHonestyProbe({
    records: result.records,
    ...(result.artifact.condition === "aborted" ? { abortVerdict: result.artifact.abortVerdict } : {}),
    observer,
    runId,
    outPath: join(runDir, HONESTY_FILE),
  });

  process.stdout.write(`${runDir}\n`);
  return 0;
}

/**
 * `run moat` — drive the memory-hygiene (moat) probe with full persistence. Per fixture task it runs a warm
 * conductor with a fork-resolving fact seeded vs. an irrelevant decoy, and scores whether recalled memory makes
 * the task route lighter (compounding) — gated by seed-landing + decoy discrimination.
 */
async function runMoat(flags: CliFlags, runner = liveRunner, judge: JudgeFn = realJudgeFn): Promise<number> {
  if (flags.fixture === undefined) throw new UsageError("run moat: --fixture <dir> is required");
  const fixtureDir = resolve(flags.fixture);
  const runsRoot = resolveRunsRoot(flags);
  const runId = newRunId(flags.runId);
  const k = flags.runs !== undefined ? Number(flags.runs) : 1;
  const judgeModel = flags.judgeModel ?? DEFAULT_JUDGE_MODEL;

  const config: RunConfig = {
    runId,
    kind: "moat",
    fixtureDir,
    k,
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    ...(flags.pluginDir !== undefined ? { pluginDir: resolve(flags.pluginDir) } : {}),
    startedAt: new Date().toISOString(),
  };
  const { store, runDir, observer } = openRun(runsRoot, runId, config);

  const result = await runMoatProbe({
    fixtureDir,
    runner,
    judge,
    judgeModel,
    outPath: join(runDir, "summary-artifact.json"),
    observer,
    runId,
    runs: k,
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    ...(flags.pluginDir !== undefined ? { pluginDir: resolve(flags.pluginDir) } : {}),
  });

  store.finishRun(summaryFor(config, result.outcomes.length, result.artifact));
  process.stdout.write(`${runDir}\n`);
  return 0;
}

/**
 * Resolve the `--cell` filter to the matrix cells. The public bench is Agentry-value-only (ADR-003): the bare
 * baseline is retired, so the only valid value is `agentry` (the single Agentry arm). The cell label derives from
 * the `--model` flag (`Agentry-<model>`) so a run at any model labels correctly. Absent `--cell` ⇒ the default
 * matrix at the resolved model; `agentry` ⇒ the same single arm. Any other value is a loud usage error (a typo
 * shouldn't silently run the wrong matrix).
 */
function cellsFromFlag(cell: string | undefined, model: string | undefined): readonly Cell[] | undefined {
  const arm = model !== undefined ? agentryCell(model) : agentryCell();
  if (cell === undefined) return [arm];
  if (cell === "agentry") return [arm];
  throw new UsageError(`run rightsizing: --cell "${cell}" is not "agentry"`);
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
      if (sub === "rightsizing") {
        return await runRightsizing(parseFlags(rest).flags, deps.runner, deps.judge);
      }
      if (sub === "moat") {
        return await runMoat(parseFlags(rest).flags, deps.runner, deps.judge);
      }
      throw new UsageError(`selfeval: unknown "run" subcommand "${sub ?? ""}" (expected "moat" | "rightsizing")`);
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
      `selfeval: unknown command "${command ?? ""}" (expected "run moat" | "run rightsizing" | "replay <id>" | "report <id>")`,
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
