// Per-run sandbox preparation — the load-bearing AC12 isolation mechanism (Plan §2.1 M2). For every run
// we mint a FRESH temp working dir plus two FRESH temp memory-root *base* dirs, then build the env that
// points `claude -p` at them. This is the recipe T-003 proved live (findings/R0-isolation.md) absorbed
// into the production module the Runner (T-004) consumes.
//
// The `Sandbox` TYPE is owned by runner/port.ts and the `Arm` type by ../types.ts — both are IMPORTED
// here, never redeclared (CLAUDE.md: never duplicate a contract type across packages/modules). The arm
// determines only the plugin layer (in arms.ts); the sandbox shape is identical across arms — fresh,
// relocated, auth-preserving. Arm C's empty roots are later filled by T-007 (M3); this task only creates
// them empty.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Arm } from "../types.ts";
import type { Sandbox } from "../runner/port.ts";

/** The env var (base dir) that relocates the global memory root — pinned by T-001. */
export const GLOBAL_DIR_ENV = "AGENTRY_GLOBAL_DIR";
/** The env var (base dir) that relocates the project memory root — pinned by T-001. */
export const PROJECT_DIR_ENV = "AGENTRY_PROJECT_DIR";

/**
 * Resolve a base dir to the memory root the file-store actually writes under. T-001's `resolveRoots`
 * treats `AGENTRY_*_DIR` as a *base* and appends `.agentry/memory`; mirror that exactly so callers
 * (assertEmptyRoots) inspect the same path the child writes to.
 */
export function memoryRootFor(baseDir: string): string {
  return join(baseDir, ".agentry", "memory");
}

/**
 * Prepare a fresh, isolated sandbox for ONE benchmark run.
 *
 * Mints three fresh temp dirs under the OS tmpdir:
 *   - a working dir the agent runs in (its produced tree is rooted here),
 *   - a global memory-root base (→ `AGENTRY_GLOBAL_DIR`),
 *   - a project memory-root base (→ `AGENTRY_PROJECT_DIR`).
 *
 * The returned `Sandbox.{globalRoot,projectRoot}` are the RESOLVED roots (`<base>/.agentry/memory`), so the
 * Runner and the isolation assertions point at the same paths the child writes records under. The env is
 * `{...process.env}` (real HOME PRESERVED → Claude auth resolves normally — R0 finding) plus the two
 * base-dir overrides. The `arm` is accepted to pin the per-run seam (arms.ts derives the plugin layer from
 * it separately); the sandbox itself is byte-identical across arms by construction — only later state
 * (T-007 seeding arm C) differs.
 */
export function prepareSandbox(_arm: Arm): Sandbox {
  const workingDir = mkdtempSync(join(tmpdir(), "agentry-bench-work-"));
  const globalBase = mkdtempSync(join(tmpdir(), "agentry-bench-global-"));
  const projectBase = mkdtempSync(join(tmpdir(), "agentry-bench-project-"));

  const env: NodeJS.ProcessEnv = {
    ...process.env, // real HOME preserved → auth stays intact (R0)
    [GLOBAL_DIR_ENV]: globalBase,
    [PROJECT_DIR_ENV]: projectBase,
  };

  return {
    workingDir,
    globalRoot: memoryRootFor(globalBase),
    projectRoot: memoryRootFor(projectBase),
    env,
  };
}
