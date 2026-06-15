// The orchestrator's run CONFIG (Plan §2.1 M8 / T-010) — the small, explicit knob-set that parameterizes a
// whole benchmark run. This module owns ONLY the config shape + its defaults + normalization; it imports no
// layer logic (the orchestrator wires the layers, the CLI parses argv into this shape).
//
// Generic constraint (CLAUDE.md): nothing repo-specific is hard-coded here. `suitePath` is supplied by the
// caller; `arms`/`n`/`seed` are caller-overridable. The ONLY baked-in default is `n` (the per-cell repeat
// count) — N=10 per the user decision (Plan §2.1 M8; config-overridable), small enough for a calibration
// shake-out yet enough that variance is defined (AC4 needs N≥2).
//
// SEED SEMANTICS (AC9, load-bearing): `seed` controls task ORDERING/SAMPLING and the bootstrap PRNG — it
// makes the run's structure deterministic so two same-config+seed runs land identical C1–C4 verdicts. It does
// NOT touch model output; the model's run-to-run noise is what the instrument MEASURES, not what it removes.

import type { Arm, Regime } from "./types.ts";

/** The four C1–C4 claim regimes the matrix must populate, plus any extra regime the suite carries. */
export const ALL_ARMS: readonly Arm[] = ["A", "B", "C"];

/** Default per-cell repeat count (user decision, Plan §2.1 M8) — config-overridable via `--n`. */
export const DEFAULT_N = 10;

/** Default bootstrap PRNG seed — config-overridable via `--seed`. Deterministic ordering/sampling (AC9). */
export const DEFAULT_SEED = 1;

/**
 * The full run configuration. `cells` is the explicit (regime × arm) selection to run; when omitted the
 * orchestrator derives it from the loaded suite (every regime present × every eligible arm). Keeping `cells`
 * optional lets a calibration run target a subset without re-authoring the suite.
 */
export interface BenchmarkConfig {
  /** Absolute or cwd-relative path to the task suite dir (each subdir with a task.yaml is one task). */
  suitePath: string;
  /** Arms to run across the matrix (Spec §4: A=plain, B=cold, C=warm). */
  arms: Arm[];
  /** Per-cell repeat count (AC4 needs ≥2 for a defined variance). Defaults to {@link DEFAULT_N}. */
  n: number;
  /** Deterministic seed for ordering/sampling + the bootstrap PRNG (AC9). NOT model output. */
  seed: number;
  /**
   * Optional explicit (regime × arm) cells to run. Absent ⇒ the orchestrator builds the matrix from the
   * loaded suite (every regime × every eligible arm in `arms`). Present ⇒ run exactly these.
   */
  cells?: { regime: Regime; arm: Arm }[];
}

/** Raw, possibly-partial config (e.g. straight from CLI parsing) before defaults + validation are applied. */
export type BenchmarkConfigInput = Partial<BenchmarkConfig> & { suitePath: string };

/**
 * Normalize a partial input into a complete, validated `BenchmarkConfig`: fill `n`/`seed`/`arms` defaults and
 * reject nonsense loudly (a bad config is a setup bug to surface, never to default silently past). `suitePath`
 * is required by the input type. `arms` defaults to all three; `n` to {@link DEFAULT_N}; `seed` to
 * {@link DEFAULT_SEED}.
 */
export function resolveConfig(input: BenchmarkConfigInput): BenchmarkConfig {
  const suitePath = input.suitePath;
  if (typeof suitePath !== "string" || suitePath.length === 0) {
    throw new Error("config: suitePath is required");
  }

  const arms = input.arms ?? [...ALL_ARMS];
  if (arms.length === 0) {
    throw new Error("config: arms must be a non-empty subset of A,B,C");
  }
  for (const arm of arms) {
    if (!ALL_ARMS.includes(arm)) {
      throw new Error(`config: unknown arm "${String(arm)}" (expected one of A,B,C)`);
    }
  }
  // Deduplicate while preserving the canonical A,B,C order so the matrix is deterministic (AC9).
  const dedupedArms = ALL_ARMS.filter((a) => arms.includes(a));

  const n = input.n ?? DEFAULT_N;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`config: n must be a positive integer, got ${String(n)}`);
  }

  const seed = input.seed ?? DEFAULT_SEED;
  if (!Number.isInteger(seed)) {
    throw new Error(`config: seed must be an integer, got ${String(seed)}`);
  }

  const config: BenchmarkConfig = { suitePath, arms: dedupedArms, n, seed };
  if (input.cells !== undefined) config.cells = input.cells;
  return config;
}
