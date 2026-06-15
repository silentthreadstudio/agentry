// The one hexagonal seam (Plan §1, §2.2): the `Runner` port wraps the volatile `claude -p` I/O so the
// grader/stats/scoreboard layers are testable against recorded fixtures with ZERO API spend. `live.ts`
// (real CLI) and `replay.ts` (recorded fixture) both implement this interface, so swapping them needs no
// caller change — DIP at the real seam only (no second abstraction layer; YAGNI).

import type { RunRecord, TreePath } from "../types.ts";

export type { TreePath };

/**
 * The Sandbox a run executes inside — a fresh temp working dir + two fresh, relocated memory roots, plus
 * the env that points `claude -p` at them. PINNED to match T-005's `prepareSandbox` output (T-005 owns
 * BUILDING a Sandbox; this port owns the TYPE so it is defined once and not duplicated — CLAUDE.md).
 * The Runner RECEIVES a prepared Sandbox; it never builds one.
 */
export interface Sandbox {
  /** Fresh temp working dir the agent runs in (its produced tree is rooted here). */
  workingDir: string;
  /** Resolved fresh global memory root for this run (via `AGENTRY_GLOBAL_DIR`). */
  globalRoot: string;
  /** Resolved fresh project memory root for this run (via `AGENTRY_PROJECT_DIR`). */
  projectRoot: string;
  /** Env to spawn `claude -p` with — carries the root overrides; passed through verbatim. */
  env: NodeJS.ProcessEnv;
}

/**
 * What to run, independent of WHERE it runs (the Sandbox). The orchestrator/arm assembles this: the prompt,
 * the model to pin (same across arms — confound rule, Spec §4), and the arm-determined plugin layer.
 * Model and `pluginDir` are DISCOVERED from config/env by the caller and passed in — the Runner hard-codes
 * nothing (CLAUDE.md generic constraint). Arm A omits `pluginDir` (no Agentry layer); B/C set it (T-005).
 */
export interface Invocation {
  /** The full prompt handed to `claude -p` (the task; the hidden suite is NEVER in it — AC10). */
  prompt: string;
  /** The model id to pin for the run (e.g. `"claude-opus-4-8[1m]"`); same across arms. */
  model: string;
  /** Repo root to load the Agentry plugin from (`--plugin-dir`). Absent ⇒ arm A (no Agentry layer). */
  pluginDir?: string;
  /** Tools to allow non-interactively (e.g. `["Task"]`); defaults handled by the impl if omitted. */
  allowedTools?: string[];
  /** Permission mode for the headless run (e.g. `"bypassPermissions"`). */
  permissionMode?: string;
}

/** The port: run an invocation inside a prepared sandbox and return the recorded result. */
export interface Runner {
  run(invocation: Invocation, sandbox: Sandbox): Promise<RunRecord>;
}
