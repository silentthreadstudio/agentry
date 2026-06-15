// The single documented HEADLESS command (Plan §2.1 M8 / T-010, AC1). Parses argv into a `BenchmarkConfig`,
// selects the Runner (live vs replay), announces the planned spend, drives the orchestrator, and exits 0 on
// success — NO TTY prompt, the artifact lands on disk. This module is the thin adapter: argv → config → run;
// it owns no layer logic (the orchestrator wires the layers).
//
//   node benchmark/src/cli.ts --suite <dir> --arms A,B,C --n <N> [--seed <s>] [--runner live|replay]
//                             [--out <scoreboard.json>] [--md <scoreboard.md>] [--replay-fixture <path>]
//
// AC1 (headless): runs in a non-interactive shell with no prompt and exits 0. Auth resolves under the real
// HOME (R0 finding) — the live Runner needs no credential injection. The replay Runner spends ZERO API (tests
// and the smoke run use it). Before any LIVE spend the planned call count (N × cells) is logged — the budget
// sign-off is the user's gate; the tool only announces, it does not block (the count goes to stderr so it is
// visible even when stdout is captured).

import { resolve } from "node:path";

import type { Arm, RunRecord } from "./types.ts";
import { resolveConfig, type BenchmarkConfigInput } from "./config.ts";
import { runBenchmark } from "./orchestrator.ts";
import { liveRunner } from "./runner/live.ts";
import { replayRunner } from "./runner/replay.ts";
import type { Invocation, Runner, Sandbox } from "./runner/port.ts";

/** Parsed CLI flags (raw strings) before they become a config. */
interface CliArgs {
  suite?: string;
  arms?: string;
  n?: string;
  seed?: string;
  runner?: string;
  out?: string;
  md?: string;
  replayFixture?: string;
}

/** Map of `--flag` → CliArgs key (kebab → camel where needed). */
const FLAGS: Record<string, keyof CliArgs> = {
  "--suite": "suite",
  "--arms": "arms",
  "--n": "n",
  "--seed": "seed",
  "--runner": "runner",
  "--out": "out",
  "--md": "md",
  "--replay-fixture": "replayFixture",
};

/** Parse `--flag value` pairs into a `CliArgs`. Unknown flags throw (a typo is a setup bug, surfaced loudly). */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const keyName = FLAGS[flag];
    if (keyName === undefined) {
      throw new Error(`cli: unknown flag "${flag}"`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`cli: flag "${flag}" expects a value`);
    }
    args[keyName] = value;
    i++;
  }
  return args;
}

/** Parse `A,B,C` into a deduped `Arm[]`; an unknown arm throws. */
function parseArms(raw: string): Arm[] {
  const arms: Arm[] = [];
  for (const part of raw.split(",")) {
    const arm = part.trim();
    if (arm !== "A" && arm !== "B" && arm !== "C") {
      throw new Error(`cli: --arms entry "${arm}" is not one of A,B,C`);
    }
    arms.push(arm);
  }
  return arms;
}

/** Turn parsed args into a normalized `BenchmarkConfig` (defaults + validation live in resolveConfig). */
export function configFromArgs(args: CliArgs): ReturnType<typeof resolveConfig> {
  if (args.suite === undefined) {
    throw new Error("cli: --suite <dir> is required");
  }
  const input: BenchmarkConfigInput = { suitePath: resolve(args.suite) };
  if (args.arms !== undefined) input.arms = parseArms(args.arms);
  if (args.n !== undefined) input.n = Number(args.n);
  if (args.seed !== undefined) input.seed = Number(args.seed);
  return resolveConfig(input);
}

/**
 * A self-contained replay record for the smoke path — an empty produced tree (grades 0% by construction,
 * AC11) with zero cost. Lets `--runner replay` exit 0 with no API spend and no external fixture, so the
 * documented smoke command (`--runner replay`, no `--replay-fixture`) is self-sufficient.
 */
const SMOKE_RECORD: RunRecord = {
  cost: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    numTurns: 0,
    totalCostUsd: 0,
    durationMs: 0,
  },
  producedTree: [],
  usedMemories: [],
  raw: { note: "cli smoke replay record (no API spend, empty produced tree)" },
};

/** A Runner that returns {@link SMOKE_RECORD} for every run — the default when `--runner replay` has no fixture. */
function smokeReplayRunner(): Runner {
  return {
    run(_invocation: Invocation, _sandbox: Sandbox): Promise<RunRecord> {
      return Promise.resolve(SMOKE_RECORD);
    },
  };
}

/**
 * Select the Runner from `--runner`. `replay` with `--replay-fixture` reads a recorded RunRecord; `replay`
 * without one uses the built-in zero-spend smoke record. `live` (the default) spends API.
 */
export function selectRunner(args: CliArgs): Runner {
  const kind = args.runner ?? "live";
  if (kind === "replay") {
    return args.replayFixture !== undefined
      ? replayRunner(resolve(args.replayFixture))
      : smokeReplayRunner();
  }
  if (kind === "live") return liveRunner;
  throw new Error(`cli: --runner must be "live" or "replay", got "${kind}"`);
}

/** Default artifact paths, relative to CWD, when `--out`/`--md` are not given. */
const DEFAULT_OUT = "scoreboard.json";

/** Run the CLI: parse, build config, select runner, drive the orchestrator. Returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  try {
    const config = configFromArgs(args);
    const runner = selectRunner(args);
    const jsonPath = resolve(args.out ?? DEFAULT_OUT);
    const options = {
      config,
      runner,
      jsonPath,
      log: (message: string) => process.stderr.write(`${message}\n`),
      ...(args.md !== undefined ? { markdownPath: resolve(args.md) } : {}),
    };

    const result = await runBenchmark(options);
    process.stdout.write(`${result.jsonPath}\n`); // stdout carries ONLY the artifact path (script-friendly)
    return 0;
  } catch (err) {
    process.stderr.write(`benchmark failed: ${(err as Error).message}\n`);
    return 1;
  }
}

// Entry point: run when invoked directly (`node benchmark/src/cli.ts ...`). No TTY prompt anywhere (AC1).
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`benchmark crashed: ${String(err)}\n`);
      process.exit(1);
    },
  );
}
