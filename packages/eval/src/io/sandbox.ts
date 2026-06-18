// Per-run sandbox preparation — the isolation recipe ported from benchmark/src/arms/sandbox.ts, trimmed of
// the `Arm` parameter (selfeval has no arms — one config). For every run we mint a FRESH temp working dir
// plus two FRESH temp memory-root *base* dirs, then build the env that points `claude -p` at them.
//
// The `Sandbox` TYPE is owned by io/port.ts and IMPORTED here, never redeclared (CLAUDE.md: never duplicate a
// contract type). This module also owns the produced-tree DISAMBIGUATOR walk — a boolean, not a tree list:
// it is the OQ1 one-shot signal (`RunResult.producedTreeNonEmpty`), NOT scoring (no grader reads it).

import { cpSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

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
 * `{...process.env}` (real HOME PRESERVED → Claude auth resolves normally) plus the base-dir overrides.
 *
 * MEMORY ROOTING under `claude -p` (verified by the moat probe): the memory layer resolves the PROJECT root as
 * `CLAUDE_PROJECT_DIR ?? AGENTRY_PROJECT_DIR`, and `claude -p` sets `CLAUDE_PROJECT_DIR` to its OWN cwd — i.e. the
 * `workingDir`. So project memory actually lives at `<workingDir>/.agentry/memory`, NOT `projectBase`; each run is
 * still isolated (the workingDir is freshly minted), and that is where a memory SEED must be written. `projectBase`
 * / `AGENTRY_PROJECT_DIR` is honored only by NON-claude runners (e.g. replay). GLOBAL memory does root at
 * `globalBase` via `AGENTRY_GLOBAL_DIR` (no `CLAUDE_*` override), so that override takes effect as written.
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
 * The basename of the live runner's teed event stream (`Invocation.streamPath`, port.ts) — it is written at
 * the `workingDir` ROOT, so it is always present live and must NOT count as the conductor's produced tree.
 */
const STREAM_FILE = "stream.jsonl";
/**
 * The basename of the primer hook's own log — written under `<workingDir>/.agentry/work/<slug>/`. It shares
 * the work folder with the conductor's routing artifacts (a known naming collision; see live.ts/extract.ts),
 * so it is excluded ONLY within the `.agentry/work/` subtree, never blanket-ignored elsewhere.
 */
const PRIMER_LOG_FILE = "events.jsonl";
/** The work-folder subtree the primer log lives under (relative to `workingDir`). */
const WORK_SUBTREE = join(".agentry", "work");

/**
 * The one-shot disambiguator's tree signal (OQ1): did the run leave a non-empty produced tree of ITS OWN?
 * Ported from benchmark's `collectProducedTree` walk, but returns a *boolean* instead of a `TreePath[]` — the
 * extractor only needs "did the run produce anything?", not the tree itself. This is disambiguator input, NOT
 * scoring (no grader reads it). Stops at the first qualifying file.
 *
 * Excludes the HARNESS's own bookkeeping, which is teed into this same `workingDir` and would otherwise make
 * the signal structurally always-true (collapsing extractShape's degenerate-vs-one-shot guard): the teed
 * `stream.jsonl` (workingDir root) and the primer hook's `events.jsonl` (under `.agentry/work/`). Everything
 * else — the conductor's `spec.md`/`plan.md`/`tasks/` artifacts AND any sandbox code edits — still counts, so
 * a workingDir with ONLY harness files reads empty while any conductor output reads non-empty.
 */
export function producedTreeNonEmpty(workingDir: string): boolean {
  const workSubtreeAbs = join(workingDir, WORK_SUBTREE);
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        if (walk(abs)) return true;
      } else if (!isHarnessBookkeeping(abs, entry, workSubtreeAbs)) {
        return true;
      }
    }
    return false;
  };
  return walk(workingDir);
}

/**
 * True iff `abs` (basename `entry`) is one of the harness's own bookkeeping files, not conductor output: the
 * teed `stream.jsonl` (anywhere), or the primer's `events.jsonl` WITHIN the `.agentry/work/` subtree.
 */
function isHarnessBookkeeping(abs: string, entry: string, workSubtreeAbs: string): boolean {
  if (entry === STREAM_FILE) return true;
  if (entry === PRIMER_LOG_FILE && abs.startsWith(workSubtreeAbs + sep)) return true;
  return false;
}
