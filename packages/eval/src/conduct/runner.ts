// SHARED CONDUCT INFRA (relocated by T-10 from `outcome/runner.ts`). `runCell` is the shared conduct primitive the
// live rightsizing probe drives, so it survived the deletion of `outcome/` and now lives in the NEUTRAL
// `src/conduct/` home — no probe imports another probe's old folder.
//
// The per-cell run orchestration (ADR-001 / ADR-002) — a THIN layer OVER the shared `Runner` port (`io/port.ts`),
// reused exactly as the routing probe reuses it (DIP at the `claude -p` boundary, replay-injectable for zero
// API). For one (fixture × cell) it: prepares an isolated sandbox (`prepareSandbox`), seeds it with the
// fixture's AGENT-VISIBLE `seed/` tree ONLY (`seedSandbox` — never `oracle/`, ADR-001), builds the per-cell
// `Invocation` (bare vs `/agentry:go`-wrapped, model pinned to sonnet, plugin loaded only for the Agentry cell),
// and drives the injected runner to completion. It returns the settled `RunResult` + the sandbox dir so the
// caller can capture-then-inject-then-run the oracle.
//
// RUN-TO-COMPLETION (ADR-002): this slice must let the build finish, NOT kill it on the first dispatch the way
// routing does. It sets T2's `runToCompletion: true` on the Invocation, so the live runner takes neither
// early-kill path and settles on the trailing `result` envelope or the `timeoutMs` hard ceiling. Tests still
// drive runs through the injected fake/replay runner (zero API); the field only changes live-run behavior.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { buildConductorPrompt } from "../conductor-prompt.ts";
import type { Invocation, RunResult, Runner, Sandbox } from "../io/port.ts";
import { prepareSandbox, seedSandbox } from "../io/sandbox.ts";

import type { Cell } from "./cell.ts";
import type { OutcomeFixture } from "./fixture.ts";

/** The default model id when the caller pins none. A generic default; the caller overrides via `--model` (ADR-003). */
export const DEFAULT_MODEL = "sonnet";

/** Default hard ceiling (ms) for a full build run — far larger than routing's killed-early cap (ADR-002). */
export const DEFAULT_TIMEOUT_MS = 600_000;

/** Per-cell run options — the resolved plugin path + model + cap the caller discovers; all optional with defaults. */
export interface RunCellOptions {
  /** Resolved `--plugin-dir` path for the Agentry cell (the repo's `plugin/` root). Required when the cell loads a plugin. */
  pluginDir?: string;
  /** Model id pinned for the run; defaults to {@link DEFAULT_MODEL}. */
  model?: string;
  /** Hard ceiling (ms) for the run; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** What `runCell` yields: the settled run record + the sandbox dir (the capture/inject/oracle source root). */
export interface RunCellResult {
  /** The runner's settled `RunResult` (the build's outcome record; cost lands here once T2 extends it). */
  result: RunResult;
  /** The sandbox working dir the agent ran in — captured (ADR-001), then oracle-injected, then torn down. */
  sandboxDir: string;
}

/**
 * Run ONE (fixture × cell) through the injected `runner` (ADR-001/002). Prepares a fresh isolated sandbox,
 * seeds it with the fixture's `seed/` tree ONLY (the oracle is never seeded — structural absence, ADR-001),
 * builds the per-cell `Invocation` (model pinned, prompt wrapped per cell, plugin + `bypassPermissions` only
 * for the Agentry cell), and drives the runner. Returns the settled `RunResult` + the sandbox dir; it does NOT
 * inject the oracle or tear down — the caller owns the capture → inject → run-oracle → teardown order (ADR-001).
 *
 * THROWS if an Agentry (plugin-loading) cell is given no `pluginDir` — a misconfigured cell is a loud bug, not
 * a silently plugin-less run. The public bench is Agentry-value-only (ADR-003), so the only live cell loads the
 * plugin; a non-plugin cell (`loadsPlugin: false`) would ignore `pluginDir` entirely.
 */
export async function runCell(
  fixture: OutcomeFixture,
  cell: Cell,
  runner: Runner,
  opts: RunCellOptions = {},
): Promise<RunCellResult> {
  if (cell.loadsPlugin && opts.pluginDir === undefined) {
    throw new Error(`runCell: cell "${cell.id}" loads the Agentry plugin but no pluginDir was provided`);
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const sandbox: Sandbox = prepareSandbox();
  // Seed the AGENT-VISIBLE tree only. The oracle/golden/broken subtrees are NEVER passed here (ADR-001): the
  // oracle is injected post-capture by the harness; golden/broken are control overlays the probe applies
  // without an agent run. Gated on the seed dir existing so a malformed fixture surfaces, not silently runs empty.
  if (existsSync(fixture.seedDir)) {
    seedSandbox(sandbox.workingDir, fixture.seedDir);
  }

  const streamPath = join(sandbox.workingDir, "stream.jsonl");
  // The Agentry cell delivers the EXPANDED go.md conductor prompt (NOT the 0-turn `/agentry:go` slash form);
  // the bare cell hands the raw task through its identity promptWrap.
  const prompt = cell.loadsPlugin
    ? buildConductorPrompt(opts.pluginDir!, fixture.prompt)
    : cell.promptWrap(fixture.prompt);

  // Build the per-cell Invocation. RUN-TO-COMPLETION (ADR-002): `runToCompletion: true` makes the live runner
  // let the build finish — it takes NEITHER early-kill path (not kill-on-first-dispatch, not terminate-on-artifact),
  // settling on the trailing `result` envelope or the `timeoutMs` hard ceiling. Without this an Agentry build would
  // be killed at its first subagent dispatch and the oracle would only ever see the seed stub. The plugin +
  // bypassPermissions ride only on the Agentry cell — the cell asymmetry is data, not a code fork.
  // BOTH cells run with bypassPermissions so each can freely write files — the comparison must isolate the
  // HARNESS, not handicap the bare cell with a permission wall (a blocked bare run would fake an outcome lift).
  // Only the plugin (the `/agentry:go` harness) is asymmetric — that is the variable under test.
  const invocation: Invocation = {
    prompt,
    model,
    streamPath,
    timeoutMs,
    runToCompletion: true,
    permissionMode: "bypassPermissions",
    ...(cell.loadsPlugin ? { pluginDir: opts.pluginDir! } : {}),
  };

  const result = await runner.run(invocation, sandbox);
  return { result, sandboxDir: sandbox.workingDir };
}
