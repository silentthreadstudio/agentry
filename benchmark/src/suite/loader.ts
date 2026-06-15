// The SUITE LOADER (Plan §2.1 M1) — enumerate the per-task fixture dirs, parse each `task.yaml`, LOCATE (but
// never expose) each task's sibling `grader/`, and ASSERT the suite is complete: every regime present, every
// task backed by a hidden suite. AC14 is an assertion, not a hope — a silently-incomplete suite invalidates
// the per-regime table (AC3), so `loadSuite` THROWS rather than returning a partial suite.
//
// AC10 by construction: this module records the `graderDir` PATH so the grader (T-006) can read it AFTER a
// run; it never copies grader/ into the working tree and never reads checks.json into a prompt. The arms
// (T-005) physically withhold grader/ from the sandbox — this loader only locates it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Regime } from "../types.ts";
import type { LessonDecl, TaskManifest } from "./manifest.ts";
import { parseManifest } from "./manifest.ts";

export type { TaskManifest, LessonDecl };

/** Every regime the suite MUST cover (AC14 enumeration); `loadSuite` throws if any is absent. */
export const REQUIRED_REGIMES: readonly Regime[] = ["R0", "R1", "R1prime", "R2", "R3"];

/**
 * One enumerated fixture task: its parsed manifest plus the resolved on-disk paths the harness needs. The
 * `graderDir` is located but held OUTSIDE the sandbox (AC10) — the grader reads it post-run; it is never
 * mounted into the working tree.
 */
export interface SuiteTask {
  manifest: TaskManifest;
  /** Absolute path to this task's fixture dir (`<suiteDir>/<id>`). */
  fixtureDir: string;
  /** Absolute path to this task's sibling `grader/` dir (located, withheld from the sandbox — AC10). */
  graderDir: string;
}

/**
 * Load + validate the whole task suite under `suiteDir`. Each immediate subdirectory containing a `task.yaml`
 * is one fixture task. Returns the enumerated `SuiteTask[]`.
 *
 * THROWS (AC14, never a partial suite) when:
 *   • a `task.yaml` is malformed (parseManifest surfaces it),
 *   • a fixture task lacks a sibling `grader/` dir,
 *   • a manifest id does not match its directory name (pairs/deps resolve by id → must be unambiguous),
 *   • duplicate task ids exist,
 *   • any required regime (R0/R1/R1prime/R2/R3) is absent from the suite,
 *   • an R3 `pair`/`deps` reference names a task id that is not in the suite.
 */
export function loadSuite(suiteDir: string): SuiteTask[] {
  const tasks: SuiteTask[] = [];
  const byId = new Map<string, SuiteTask>();

  for (const entry of readdirSync(suiteDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fixtureDir = join(suiteDir, entry.name);
    const manifestPath = join(fixtureDir, "task.yaml");
    if (!isFile(manifestPath)) continue; // not a fixture dir (e.g. warm-snapshot/) — skip, don't fail.

    const manifest = parseManifest(readFileSync(manifestPath, "utf8"), manifestPath);
    if (manifest.id !== entry.name) {
      throw new Error(
        `suite ${suiteDir}: fixture dir "${entry.name}" declares id "${manifest.id}" — id must match dir name (pairs/deps resolve by id)`,
      );
    }
    if (byId.has(manifest.id)) {
      throw new Error(`suite ${suiteDir}: duplicate task id "${manifest.id}"`);
    }

    const graderDir = join(fixtureDir, "grader");
    if (!isDir(graderDir)) {
      throw new Error(
        `suite ${suiteDir}: task "${manifest.id}" has no grader/ dir — every task needs a hidden suite (AC14)`,
      );
    }

    const task: SuiteTask = { manifest, fixtureDir, graderDir };
    tasks.push(task);
    byId.set(manifest.id, task);
  }

  assertAllRegimesPresent(tasks, suiteDir);
  assertCrossRefsResolve(tasks, byId, suiteDir);

  return tasks;
}

function assertAllRegimesPresent(tasks: SuiteTask[], suiteDir: string): void {
  const present = new Set(tasks.map((t) => t.manifest.regime));
  const missing = REQUIRED_REGIMES.filter((r) => !present.has(r));
  if (missing.length > 0) {
    throw new Error(`suite ${suiteDir}: missing required regime(s): ${missing.join(", ")} (AC14)`);
  }
}

function assertCrossRefsResolve(
  tasks: SuiteTask[],
  byId: Map<string, SuiteTask>,
  suiteDir: string,
): void {
  for (const task of tasks) {
    const { id, pair, deps } = task.manifest;
    if (pair !== undefined && !byId.has(pair)) {
      throw new Error(`suite ${suiteDir}: task "${id}" pairs with unknown id "${pair}"`);
    }
    for (const dep of deps ?? []) {
      if (!byId.has(dep)) {
        throw new Error(`suite ${suiteDir}: task "${id}" depends on unknown id "${dep}"`);
      }
    }
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
