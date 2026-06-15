// Tests for M3 warm-seeding (T-007 — restoreWarmSnapshot). ZERO API spend: pure filesystem cp -R + a
// byte-for-byte diff of the restored roots against the versioned snapshot fixture.
//
// Coverage maps to the task's Acceptance 5: restoreWarmSnapshot produces byte-identical roots from
// fixtures/warm-snapshot/ into a fresh sandbox (AC7/8/9/12C).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { Sandbox } from "../src/runner/port.ts";
import { memoryRootFor, prepareSandbox } from "../src/arms/sandbox.ts";
import {
  defaultSnapshotDir,
  restoreWarmSnapshot,
  SNAPSHOT_GLOBAL_SUBDIR,
  SNAPSHOT_PROJECT_SUBDIR,
} from "../src/arms/seed.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, "..", "fixtures", "warm-snapshot");

/** Walk a dir, returning every file's relative path (sorted) — for a deterministic tree comparison. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const child of listFiles(join(root, entry.name))) out.push(join(entry.name, child));
    } else {
      out.push(entry.name);
    }
  }
  return out.sort();
}

/** Assert two dir trees are byte-identical (same relative paths, same content per file). */
function assertTreesIdentical(expected: string, actual: string): void {
  const a = listFiles(expected);
  const b = listFiles(actual);
  assert.deepEqual(b, a, "restored tree must have the same files as the snapshot");
  for (const rel of a) {
    assert.deepEqual(
      readFileSync(join(actual, rel)),
      readFileSync(join(expected, rel)),
      `file ${rel} must be byte-identical`,
    );
  }
}

test("restoreWarmSnapshot copies both roots byte-identically into a fresh sandbox (AC7/8/9/12C)", () => {
  const sandbox = prepareSandbox("C");
  try {
    restoreWarmSnapshot(sandbox);
    assertTreesIdentical(join(SNAPSHOT, SNAPSHOT_GLOBAL_SUBDIR), sandbox.globalRoot);
    assertTreesIdentical(join(SNAPSHOT, SNAPSHOT_PROJECT_SUBDIR), sandbox.projectRoot);
  } finally {
    cleanup(sandbox);
  }
});

test("restoreWarmSnapshot restores INTO the roots prepareSandbox created (paths, not new roots)", () => {
  const sandbox = prepareSandbox("C");
  try {
    // The roots are the resolved <base>/.agentry/memory dirs the file-store writes under.
    assert.equal(sandbox.globalRoot, memoryRootFor(sandbox.env.AGENTRY_GLOBAL_DIR!));
    assert.equal(sandbox.projectRoot, memoryRootFor(sandbox.env.AGENTRY_PROJECT_DIR!));
    restoreWarmSnapshot(sandbox);
    assert.ok(statSync(sandbox.globalRoot).isDirectory(), "global root populated in place");
    assert.ok(statSync(sandbox.projectRoot).isDirectory(), "project root populated in place");
  } finally {
    cleanup(sandbox);
  }
});

test("a real `diff -r` confirms byte-identical restore (cp -R + diff, the AC5 method)", () => {
  const sandbox = prepareSandbox("C");
  try {
    restoreWarmSnapshot(sandbox);
    // diff -r exits 0 iff the trees are identical; it throws (non-zero) on any difference.
    execFileSync("diff", ["-r", join(SNAPSHOT, SNAPSHOT_GLOBAL_SUBDIR), sandbox.globalRoot], { stdio: "ignore" });
    execFileSync("diff", ["-r", join(SNAPSHOT, SNAPSHOT_PROJECT_SUBDIR), sandbox.projectRoot], { stdio: "ignore" });
  } finally {
    cleanup(sandbox);
  }
});

test("two independent restores into separate sandboxes produce identical roots (deterministic)", () => {
  const a = prepareSandbox("C");
  const b = prepareSandbox("C");
  try {
    restoreWarmSnapshot(a);
    restoreWarmSnapshot(b);
    assertTreesIdentical(a.globalRoot, b.globalRoot);
    assertTreesIdentical(a.projectRoot, b.projectRoot);
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

test("defaultSnapshotDir resolves to the committed fixtures/warm-snapshot", () => {
  assert.equal(defaultSnapshotDir(), join(HERE, "..", "fixtures", "warm-snapshot"));
});

/** Remove a sandbox's temp dirs (working dir + both root bases). */
function cleanup(sandbox: Sandbox): void {
  for (const dir of [sandbox.workingDir, sandbox.env.AGENTRY_GLOBAL_DIR, sandbox.env.AGENTRY_PROJECT_DIR]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
