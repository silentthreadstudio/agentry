// The headless decision-quality command (design §5) — mirrors routing/command.ts. Thin adapter: argv → opts →
// `runQualityProbe` → write artifact → exit 0, with the artifact path as the ONLY thing on stdout (announcements
// go to stderr so a script can capture the path cleanly). It owns no probe logic — probe.ts wires the gated flow;
// this module only loads the fixtures, selects the judge, and plumbs flags.
//
//   node selfeval/src/quality/command.ts --fixtures <dir> [--artifacts <inputs.json>] [--out <path>] [--k 3]
//
// The judge spends API and is R-gated (it shells out to `claude -p`); the unit tests inject a canned judge and
// never reach this entrypoint's real-judge default. `--fixtures` points at a dir holding `task.txt`,
// `gold/spec.md`, and `poor/spec.md` (the planted positive-control ground truth). `--artifacts` is an optional
// JSON array of `{ taskId, taskPrompt, artifactText }` inputs to score; absent ⇒ the planted GOLD and POOR
// specs are scored as the inputs (a self-contained smoke run).

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runQualityProbe, type QualityInput, type PlantedFixtures } from "./probe.ts";
import { realJudgeFn, type JudgeFn } from "./judge.ts";

/** Parsed CLI flags (raw strings) before they become probe options. */
interface CliArgs {
  fixtures?: string;
  artifacts?: string;
  out?: string;
  k?: string;
}

/** Map of `--flag` → CliArgs key. */
const FLAGS: Record<string, keyof CliArgs> = {
  "--fixtures": "fixtures",
  "--artifacts": "artifacts",
  "--out": "out",
  "--k": "k",
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

/** Load the planted fixtures (task.txt + gold/spec.md + poor/spec.md) from `--fixtures <dir>`. */
export function loadPlantedFixtures(fixturesDir: string): PlantedFixtures {
  return {
    taskPrompt: readFileSync(join(fixturesDir, "task.txt"), "utf8"),
    goldText: readFileSync(join(fixturesDir, "gold", "spec.md"), "utf8"),
    poorText: readFileSync(join(fixturesDir, "poor", "spec.md"), "utf8"),
  };
}

/**
 * Resolve the input artifacts to score. `--artifacts <p>` reads a JSON array of `{ taskId, taskPrompt,
 * artifactText }`; absent ⇒ the planted GOLD and POOR specs are scored as the inputs (a self-contained run that
 * needs no routing capture). A malformed `--artifacts` file throws loudly rather than scoring nothing.
 */
export function resolveInputs(args: CliArgs, planted: PlantedFixtures): QualityInput[] {
  if (args.artifacts === undefined) {
    return [
      { taskId: "planted-gold", taskPrompt: planted.taskPrompt, artifactText: planted.goldText },
      { taskId: "planted-poor", taskPrompt: planted.taskPrompt, artifactText: planted.poorText },
    ];
  }
  const raw = JSON.parse(readFileSync(resolve(args.artifacts), "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("command: --artifacts must be a JSON array of { taskId, taskPrompt, artifactText }");
  }
  return raw.map((entry, i) => {
    const e = entry as Partial<QualityInput>;
    if (typeof e.taskId !== "string" || typeof e.taskPrompt !== "string" || typeof e.artifactText !== "string") {
      throw new Error(`command: --artifacts[${i}] must have string taskId, taskPrompt, artifactText`);
    }
    return { taskId: e.taskId, taskPrompt: e.taskPrompt, artifactText: e.artifactText };
  });
}

/** Default artifact path, relative to CWD, when `--out` is not given. */
const DEFAULT_OUT = "decision-quality.json";

/**
 * Run the command: parse, load fixtures, drive the probe, write the artifact. The `judge` is injectable so a
 * test can drive `main` with a canned judge (zero API); production uses the probe's real `claude -p` default.
 * Returns the process exit code.
 */
export async function main(argv: readonly string[], judge?: JudgeFn): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  try {
    if (args.fixtures === undefined) {
      throw new Error("command: --fixtures <dir> is required");
    }
    const fixturesDir = resolve(args.fixtures);
    const outPath = resolve(args.out ?? DEFAULT_OUT);
    const planted = loadPlantedFixtures(fixturesDir);
    const artifacts = resolveInputs(args, planted);

    process.stderr.write(`decision-quality self-eval: fixtures=${fixturesDir} artifacts=${artifacts.length}\n`);

    // No injected judge ⇒ the real `claude -p` judge (R-gated, spends API); tests inject a canned judge.
    const result = await runQualityProbe({
      artifacts,
      planted,
      judge: judge ?? realJudgeFn,
      outPath,
      ...(args.k !== undefined ? { k: Number(args.k) } : {}),
    });

    if (result.artifact.condition === "aborted") {
      process.stderr.write(`control gate fired: ${result.artifact.abortVerdict} — no scores emitted\n`);
    } else {
      process.stderr.write(`overallMean=${result.artifact.overallMean} (N=${result.artifact.scores?.length})\n`);
    }

    process.stdout.write(`${result.outPath}\n`); // stdout carries ONLY the artifact path (script-friendly)
    return 0;
  } catch (err) {
    process.stderr.write(`decision-quality self-eval failed: ${(err as Error).message}\n`);
    return 1;
  }
}

// Entry point: run when invoked directly. No TTY prompt.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`decision-quality self-eval crashed: ${String(err)}\n`);
      process.exit(1);
    },
  );
}
