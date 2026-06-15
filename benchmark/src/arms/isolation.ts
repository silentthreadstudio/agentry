// The isolation guarantees that make the benchmark trustworthy:
//   - assertEmptyRoots  — AC12 cold/plain: a run's memory roots hold ZERO records (after a confirmed run).
//   - assertNoCrossRunLeak — AC12b: two back-to-back prepares in a cell start byte-identical empty.
//   - withholdGrader    — AC10 (filesystem half): the hidden grader/ suite is NEVER copied into the tree
//                          the agent runs in, so the agent cannot read the answer key off disk.
//
// The `Sandbox` TYPE is owned by ../runner/port.ts and IMPORTED here (CLAUDE.md: never duplicate a
// contract type). Memory records are one `.md` file per record under `<root>/{facts,episodes}/` — the
// file-store is the source of truth (packages/memory/src/persistence/file-store.ts); an absent dir = zero.

import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Sandbox } from "../runner/port.ts";

/** The fixture subdir that holds the hidden suite/answer key — never copied into the agent's tree (AC10). */
export const GRADER_DIR = "grader";

/**
 * Count memory records (`.md` files) under a single RESOLVED memory root, across `facts/` + `episodes/`.
 * Pure + side-effect-free (reads only); a missing dir counts as zero and never throws.
 */
export function countMemoryRecords(memoryRoot: string): number {
  let count = 0;
  for (const kind of ["facts", "episodes"] as const) {
    const dir = join(memoryRoot, kind);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".md")) count++;
    }
  }
  return count;
}

/**
 * Assert a sandbox's memory roots are byte-empty (AC12 cold/plain). Throws if EITHER the global or the
 * project root holds any memory record; the message names which root and the count.
 *
 * Sequencing note (R0 finding, the orchestrator's responsibility — NOT enforced here): run this AFTER a
 * confirmed-successful run, else "empty because isolated" is indistinguishable from "empty because the
 * plugin/auth failed and nothing ran". This function asserts emptiness only; the caller proves the run
 * succeeded first.
 */
export function assertEmptyRoots(sandbox: Sandbox): void {
  const globalRecords = countMemoryRecords(sandbox.globalRoot);
  const projectRecords = countMemoryRecords(sandbox.projectRoot);
  if (globalRecords > 0 || projectRecords > 0) {
    throw new Error(
      `Memory roots are not empty (AC12 violated): ` +
        `global root ${sandbox.globalRoot} has ${globalRecords} record(s), ` +
        `project root ${sandbox.projectRoot} has ${projectRecords} record(s).`,
    );
  }
}

/**
 * Assert two back-to-back prepared sandboxes start byte-identical empty (AC12b — no cross-run leak within
 * a cell). Both roots of both sandboxes must hold zero records, and the two sandboxes must use DISTINCT
 * working/root paths (a reused dir would let run #1's state leak into run #2). Throws on either failure.
 */
export function assertNoCrossRunLeak(first: Sandbox, second: Sandbox): void {
  assertEmptyRoots(first);
  assertEmptyRoots(second);

  if (first.workingDir === second.workingDir) {
    throw new Error(`Cross-run leak: both runs share working dir ${first.workingDir}.`);
  }
  if (first.globalRoot === second.globalRoot) {
    throw new Error(`Cross-run leak: both runs share global root ${first.globalRoot}.`);
  }
  if (first.projectRoot === second.projectRoot) {
    throw new Error(`Cross-run leak: both runs share project root ${first.projectRoot}.`);
  }
}

/**
 * Copy a task fixture's tree into the sandbox working dir while WITHHOLDING the grader/ subdir (AC10,
 * filesystem half). The agent gets the task inputs but never the hidden suite/answer key on disk, so it
 * cannot read the answers off the filesystem. Returns nothing; the working tree is left ready to run.
 *
 * Throws if the fixture dir does not exist (a missing task fixture is a setup bug, not a silent no-op).
 */
export function withholdGrader(taskFixtureDir: string, sandbox: Sandbox): void {
  if (!existsSync(taskFixtureDir)) {
    throw new Error(`Task fixture dir does not exist: ${taskFixtureDir}`);
  }
  cpSync(taskFixtureDir, sandbox.workingDir, {
    recursive: true,
    // Exclude the grader/ dir (and anything beneath it) from the copy — the answer key never lands in
    // the tree the agent runs in.
    filter: (src) => !isWithinGrader(taskFixtureDir, src),
  });
}

/** True when `src` is the fixture's grader/ dir or any path beneath it. */
function isWithinGrader(taskFixtureDir: string, src: string): boolean {
  const graderRoot = join(taskFixtureDir, GRADER_DIR);
  return src === graderRoot || src.startsWith(graderRoot + "/");
}
