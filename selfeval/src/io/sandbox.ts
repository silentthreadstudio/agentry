// Per-run sandbox preparation — the isolation recipe ported from benchmark/src/arms/sandbox.ts, trimmed of
// the `Arm` parameter (selfeval has no arms — one config). For every run we mint a FRESH temp working dir
// plus two FRESH temp memory-root *base* dirs, then build the env that points `claude -p` at them.
//
// The `Sandbox` TYPE is owned by io/port.ts and IMPORTED here, never redeclared (CLAUDE.md: never duplicate a
// contract type). This module also owns the produced-tree DISAMBIGUATOR walk — a boolean, not a tree list:
// it is the OQ1 one-shot signal (`RunResult.producedTreeNonEmpty`), NOT scoring (no grader reads it).

import { cpSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Sandbox } from "./port.ts";

/** The env var (base dir) that relocates the global memory root. */
export const GLOBAL_DIR_ENV = "AGENTRY_GLOBAL_DIR";
/** The env var (base dir) that relocates the project memory root. */
export const PROJECT_DIR_ENV = "AGENTRY_PROJECT_DIR";
/**
 * The env var that puts the conductor in AUTO-PILOT (autopilot-design §1): decide-record-proceed at every
 * gate instead of blocking on `AskUserQuestion`, and ALWAYS emit the decision artifact on any escalation
 * above one-shot. The probe sets it so the headless run produces the work-folder artifacts the extractor
 * reads (the faithful routing signal — autopilot-design §2/§3), never stalling on an interactive gate.
 */
export const AUTOPILOT_ENV = "AGENTRY_AUTOPILOT";

/**
 * Resolve a base dir to the memory root the file-store actually writes under. The memory layer treats
 * `AGENTRY_*_DIR` as a *base* and appends `.agentry/memory`; mirror that exactly so callers inspect the same
 * path the child writes to.
 */
export function memoryRootFor(baseDir: string): string {
  return join(baseDir, ".agentry", "memory");
}

/**
 * Prepare a fresh, isolated sandbox for ONE probe run.
 *
 * Mints three fresh temp dirs under the OS tmpdir:
 *   - a working dir the agent runs in (its produced tree is rooted here),
 *   - a global memory-root base (→ `AGENTRY_GLOBAL_DIR`),
 *   - a project memory-root base (→ `AGENTRY_PROJECT_DIR`).
 *
 * The returned `Sandbox.{globalRoot,projectRoot}` are the RESOLVED roots (`<base>/.agentry/memory`), so the
 * Runner and any isolation assertion point at the same paths the child writes under. The env is
 * `{...process.env}` (real HOME PRESERVED → Claude auth resolves normally) plus the two base-dir overrides.
 *
 * No `arm` parameter (ported from benchmark, dropped): selfeval has a single config, not arms.
 */
export function prepareSandbox(): Sandbox {
  const workingDir = mkdtempSync(join(tmpdir(), "agentry-selfeval-work-"));
  const globalBase = mkdtempSync(join(tmpdir(), "agentry-selfeval-global-"));
  const projectBase = mkdtempSync(join(tmpdir(), "agentry-selfeval-project-"));

  const env: NodeJS.ProcessEnv = {
    ...process.env, // real HOME preserved → auth stays intact
    [GLOBAL_DIR_ENV]: globalBase,
    [PROJECT_DIR_ENV]: projectBase,
    [AUTOPILOT_ENV]: "1", // decide-record-proceed: the conductor emits routing artifacts, never blocks a gate
  };

  return {
    workingDir,
    globalRoot: memoryRootFor(globalBase),
    projectRoot: memoryRootFor(projectBase),
    env,
  };
}

/**
 * Seed a prepared sandbox's working dir with a realistic starting codebase. Recursively copies the CONTENTS
 * of `seedDir` into `workingDir` so the task's prompt references real files (a premise the empty sandbox
 * would otherwise make false, collapsing multi-part tasks to one-shot).
 *
 * Pure fs, one concern: it does not check for the dir's existence (the caller gates on that) and does not
 * touch the env or memory roots. `cpSync(..., { recursive: true })` merges `seedDir`'s tree onto the
 * (freshly-minted, empty) working dir.
 */
export function seedSandbox(workingDir: string, seedDir: string): void {
  cpSync(seedDir, workingDir, { recursive: true });
}

/**
 * The one-shot disambiguator's tree signal (OQ1): does `workingDir` contain at least one file? Ported from
 * benchmark's `collectProducedTree` walk, but returns a *boolean* instead of a `TreePath[]` — the extractor
 * only needs "did the run leave a non-empty produced tree?", not the tree itself. This is disambiguator
 * input, NOT scoring (no grader reads it). Stops at the first file found.
 */
export function producedTreeNonEmpty(workingDir: string): boolean {
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        if (walk(abs)) return true;
      } else {
        return true;
      }
    }
    return false;
  };
  return walk(workingDir);
}
