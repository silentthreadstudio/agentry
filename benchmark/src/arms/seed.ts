// M3 WARM-SEEDING (Plan §2.1 M3) — fill arm C's fresh roots with the teacher-run memory snapshot so the warm
// arm starts from a populated moat. This module adds ONLY the warm-fill; it restores INTO the empty roots
// `prepareSandbox` (T-005) already created — it never mints or relocates roots (that is T-005's sandbox.ts).
//
// What is snapshotted (Spec §6.1 OQ5): the file-store is the SOLE truth and the SQLite index is `:memory:`,
// so there is no `.db` on disk to capture — only the two Markdown root dirs. The snapshot is committed as a
// small, git-diffable fixture (ADR-002 Fork A: commit-as-fixture). Restore is a byte-faithful `cp -R`, so the
// warm run sees exactly the teacher's records (AC7/8/9/12C).
//
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// ONE-TIME CAPTURE (how fixtures/warm-snapshot/ was produced — documented, not automated)
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
//   1. Run the R3 TEACHER task once through the warm pipeline against a throwaway sandbox so its memory roots
//      fill with the teacher's records (the lesson the follow-up reuses lands in the file store).
//   2. Copy the two RESOLVED root dirs out of that sandbox into the versioned fixture, normalizing the layout
//      this module restores from:
//        cp -R "<sandbox.globalRoot>/."  benchmark/fixtures/warm-snapshot/global/
//        cp -R "<sandbox.projectRoot>/." benchmark/fixtures/warm-snapshot/project/
//      (`sandbox.{globalRoot,projectRoot}` are `<base>/.agentry/memory` — see sandbox.ts:memoryRootFor.)
//   3. Commit the result. RE-SNAPSHOT whenever the memory record file format / frontmatter changes
//      (Plan §4.6 gotcha) — the snapshot is tied to that on-disk schema.
//
// The seed suite in this repo ships a minimal hand-authored snapshot (one record per root) that exercises the
// exact restore contract; replace it with a real teacher capture when running the live benchmark.

import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Sandbox } from "../runner/port.ts";

/** The two-root layout inside the versioned snapshot fixture — one subdir per resolved memory root. */
export const SNAPSHOT_GLOBAL_SUBDIR = "global";
export const SNAPSHOT_PROJECT_SUBDIR = "project";

/** The versioned snapshot fixture dir (benchmark/fixtures/warm-snapshot), resolved from this module. */
export function defaultSnapshotDir(): string {
  // seed.ts lives at benchmark/src/arms/ → ../../fixtures/warm-snapshot.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "warm-snapshot");
}

/**
 * Restore the teacher-run warm snapshot INTO a prepared sandbox's two memory roots (arm C). Copies the
 * versioned `fixtures/warm-snapshot/{global,project}/` trees byte-for-byte into `sandbox.globalRoot` /
 * `sandbox.projectRoot` — the roots `prepareSandbox` already created (this fills them; it does not rebuild
 * them). After this call the warm arm's roots are byte-identical to the snapshot (AC7/8/9/12C).
 *
 * `snapshotDir` is injectable for tests (so they need not depend on the shipped fixture); it defaults to the
 * committed `fixtures/warm-snapshot/`.
 */
export function restoreWarmSnapshot(sandbox: Sandbox, snapshotDir: string = defaultSnapshotDir()): void {
  copyTree(join(snapshotDir, SNAPSHOT_GLOBAL_SUBDIR), sandbox.globalRoot);
  copyTree(join(snapshotDir, SNAPSHOT_PROJECT_SUBDIR), sandbox.projectRoot);
}

/** `cp -R <src>/. <dest>/` — recursive, preserving the tree under `src` into an existing-or-created `dest`. */
function copyTree(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  // recursive copy of src's CONTENTS into dest (cpSync copies src itself → name dest as the target root).
  cpSync(src, dest, { recursive: true });
}
