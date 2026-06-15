// The single documented HEADLESS command (T-5 / AC3) — mirrors `benchmark/src/cli.ts` but DOES NOT grade.
// Thin adapter: argv → opts → `runRoutingProbe` → write artifact → exit 0, with the artifact path as the ONLY
// thing on stdout (announcements go to stderr so a script can capture the path cleanly). It owns no probe
// logic — `probe.ts` wires the gated control flow; this module only selects the runner and plumbs flags.
//
//   node selfeval/src/routing/command.ts --fixture <dir> --runner live|replay [--out <path>] [--k 3]
//                                        [--x <threshold>] [--replay-fixture <p>] [--replay-fixtures a,b,c]
//
// AC3 (headless): runs non-interactively, no TTY prompt, exits 0 on success; the artifact lands on disk and
// its path is echoed to stdout. The replay runner spends ZERO API (tests and offline runs use it); `live`
// spends API and is R1-gated.

import { resolve } from "node:path";

import { liveRunner } from "../io/live.ts";
import { replayRunner, replaySequenceRunner } from "../io/replay.ts";
import type { Runner } from "../io/port.ts";
import { runRoutingProbe } from "./probe.ts";

/** Parsed CLI flags (raw strings) before they become probe options. */
interface CliArgs {
  fixture?: string;
  runner?: string;
  out?: string;
  k?: string;
  x?: string;
  replayFixture?: string;
  replayFixtures?: string;
}

/** Map of `--flag` → CliArgs key (kebab → camel where needed). */
const FLAGS: Record<string, keyof CliArgs> = {
  "--fixture": "fixture",
  "--runner": "runner",
  "--out": "out",
  "--k": "k",
  "--x": "x",
  "--replay-fixture": "replayFixture",
  "--replay-fixtures": "replayFixtures",
};

/** Parse `--flag value` pairs into a `CliArgs`. Unknown flags throw (a typo is a setup bug, surfaced loudly). */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const keyName = FLAGS[flag];
    if (keyName === undefined) {
      throw new Error(`command: unknown flag "${flag}"`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`command: flag "${flag}" expects a value`);
    }
    args[keyName] = value;
    i++;
  }
  return args;
}

/**
 * Select the Runner from `--runner`. `live` (real `claude -p`, R1-gated) is the default; `replay` reads a
 * single recorded `RunResult` (`--replay-fixture`) or a sequence (`--replay-fixtures a,b,c`, one per run). A
 * `replay` without either fixture flag is a setup error (there is nothing to replay) — thrown loudly.
 */
export function selectRunner(args: CliArgs): Runner {
  const kind = args.runner ?? "live";
  if (kind === "live") return liveRunner;
  if (kind === "replay") {
    if (args.replayFixtures !== undefined) {
      const paths = args.replayFixtures.split(",").map((p) => resolve(p.trim()));
      return replaySequenceRunner(paths);
    }
    if (args.replayFixture !== undefined) {
      return replayRunner(resolve(args.replayFixture));
    }
    throw new Error("command: --runner replay needs --replay-fixture <p> or --replay-fixtures <a,b,c>");
  }
  throw new Error(`command: --runner must be "live" or "replay", got "${kind}"`);
}

/** Default artifact path, relative to CWD, when `--out` is not given. */
const DEFAULT_OUT = "routing-accuracy.json";

/** Run the command: parse, select runner, drive the probe, write the artifact. Returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  try {
    if (args.fixture === undefined) {
      throw new Error("command: --fixture <dir> is required");
    }
    const runner = selectRunner(args);
    const fixtureDir = resolve(args.fixture);
    const outPath = resolve(args.out ?? DEFAULT_OUT);

    process.stderr.write(`routing self-eval: fixture=${fixtureDir} runner=${args.runner ?? "live"}\n`);

    const result = await runRoutingProbe({
      fixtureDir,
      runner,
      outPath,
      ...(args.k !== undefined ? { k: Number(args.k) } : {}),
      ...(args.x !== undefined ? { x: Number(args.x) } : {}),
    });

    if (result.artifact.condition === "aborted") {
      process.stderr.write(`control gate fired: ${result.artifact.abortVerdict} — no score emitted\n`);
    } else {
      process.stderr.write(`accuracy=${result.artifact.accuracy} (early-signal, N=${result.outcomes.length})\n`);
    }

    process.stdout.write(`${result.outPath}\n`); // stdout carries ONLY the artifact path (script-friendly)
    return 0;
  } catch (err) {
    process.stderr.write(`routing self-eval failed: ${(err as Error).message}\n`);
    return 1;
  }
}

// Entry point: run when invoked directly (`node selfeval/src/routing/command.ts ...`). No TTY prompt (AC3).
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`routing self-eval crashed: ${String(err)}\n`);
      process.exit(1);
    },
  );
}
