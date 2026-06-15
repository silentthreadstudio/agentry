// Unit tests for the M2 arms + isolation modules (Task T-005). ZERO API spend — every assertion runs
// against fixture dirs and prepared (but never executed) sandboxes; `claude -p` is NEVER invoked here.
// Covers the four task acceptance items:
//   AC1 — prepareSandbox('B') → two fresh empty roots + both env vars; prepareSandbox('A') omits plugin layer.
//   AC2 — assertEmptyRoots throws on a non-empty root, passes on a fresh pair.
//   AC3 — two back-to-back prepares start byte-identical empty (distinct paths, both empty).
//   AC4 — withholdGrader leaves no grader/ file in the working tree.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { after, test } from "node:test";

import {
  GLOBAL_DIR_ENV,
  PROJECT_DIR_ENV,
  memoryRootFor,
  prepareSandbox,
} from "../src/arms/sandbox.ts";
import { armLoadsAgentry, armPluginDir, discoverRepoRoot } from "../src/arms/arms.ts";
import {
  GRADER_DIR,
  assertEmptyRoots,
  assertNoCrossRunLeak,
  countMemoryRecords,
  withholdGrader,
} from "../src/arms/isolation.ts";
import type { Sandbox } from "../src/runner/port.ts";

// --- test scaffolding ------------------------------------------------------------------------------

const made: string[] = [];
function track<T extends string>(dir: T): T {
  made.push(dir);
  return dir;
}
function freshDir(label: string): string {
  return track(mkdtempSync(join(tmpdir(), `arms-test-${label}-`)));
}
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** Track the temp dirs a prepared sandbox owns so they are cleaned up after the run. */
function trackSandbox(s: Sandbox): Sandbox {
  made.push(s.workingDir);
  // roots are <base>/.agentry/memory; remove the base (two dirs up) to clean fully.
  made.push(join(s.globalRoot, "..", ".."));
  made.push(join(s.projectRoot, "..", ".."));
  return s;
}

/** Seed a memory record `.md` under a RESOLVED root (mirrors the file-store layout). */
function seedRecord(memoryRoot: string, kind: "facts" | "episodes", name: string): void {
  const dir = join(memoryRoot, kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), "---\nid: x\n---\n\nbody\n");
}

/** List every file under a dir, as paths relative to it (for tree assertions). */
function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(root, abs).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

// --- AC1: prepareSandbox produces fresh empty roots + both env vars; arm A omits the plugin layer ----

test("prepareSandbox(B) sets both override env vars to fresh base dirs (AC1)", () => {
  const sandbox = trackSandbox(prepareSandbox("B"));

  assert.equal(typeof sandbox.env[GLOBAL_DIR_ENV], "string");
  assert.equal(typeof sandbox.env[PROJECT_DIR_ENV], "string");
  // The resolved roots are <base>/.agentry/memory of exactly those base dirs.
  assert.equal(sandbox.globalRoot, memoryRootFor(sandbox.env[GLOBAL_DIR_ENV] as string));
  assert.equal(sandbox.projectRoot, memoryRootFor(sandbox.env[PROJECT_DIR_ENV] as string));
});

test("prepareSandbox(B) yields two fresh, empty, distinct roots + a distinct working dir (AC1)", () => {
  const sandbox = trackSandbox(prepareSandbox("B"));

  assert.equal(countMemoryRecords(sandbox.globalRoot), 0);
  assert.equal(countMemoryRecords(sandbox.projectRoot), 0);
  assert.notEqual(sandbox.globalRoot, sandbox.projectRoot);
  assert.notEqual(sandbox.workingDir, sandbox.globalRoot);
  assert.ok(existsSync(sandbox.workingDir), "working dir is created on disk");
});

test("prepareSandbox preserves the real HOME so auth resolves (R0 recipe)", () => {
  const sandbox = trackSandbox(prepareSandbox("B"));
  assert.equal(sandbox.env.HOME, process.env.HOME);
});

test("prepareSandbox(A) omits the Agentry plugin layer — armPluginDir(A) is undefined (AC1)", () => {
  // Arm A must GENUINELY lack --plugin-dir, not merely have empty roots.
  assert.equal(armPluginDir("A"), undefined);
  assert.equal(armLoadsAgentry("A"), false);
});

test("arms B and C load the Agentry layer with a discovered repo root (AC1)", () => {
  assert.equal(armLoadsAgentry("B"), true);
  assert.equal(armLoadsAgentry("C"), true);
  // injected repoRoot is passed straight through to --plugin-dir for B/C.
  assert.equal(armPluginDir("B", "/some/repo"), "/some/repo");
  assert.equal(armPluginDir("C", "/some/repo"), "/some/repo");
});

test("discoverRepoRoot honors the AGENTRY_REPO_DIR override, else resolves the real repo root", () => {
  const prev = process.env.AGENTRY_REPO_DIR;
  try {
    process.env.AGENTRY_REPO_DIR = "/override/repo";
    assert.equal(discoverRepoRoot(), "/override/repo");
  } finally {
    if (prev === undefined) delete process.env.AGENTRY_REPO_DIR;
    else process.env.AGENTRY_REPO_DIR = prev;
  }
  // Without the override it resolves to the actual repo root (the dir holding benchmark/ + agents/).
  const discovered = discoverRepoRoot();
  assert.ok(existsSync(join(discovered, "benchmark")), "discovered root contains benchmark/");
  assert.ok(existsSync(join(discovered, "CLAUDE.md")), "discovered root contains CLAUDE.md");
});

// --- AC2: assertEmptyRoots throws on non-empty, passes on fresh -------------------------------------

/** Build a Sandbox pointing at two given resolved roots (working dir/env irrelevant to the assertions). */
function sandboxOver(globalRoot: string, projectRoot: string): Sandbox {
  return { workingDir: "/unused", globalRoot, projectRoot, env: {} };
}

test("assertEmptyRoots passes for a fresh empty pair (AC2)", () => {
  const sandbox = trackSandbox(prepareSandbox("B"));
  assert.doesNotThrow(() => assertEmptyRoots(sandbox));
});

test("assertEmptyRoots throws when the global root holds a record (AC2)", () => {
  const globalRoot = memoryRootFor(freshDir("g-dirty"));
  const projectRoot = memoryRootFor(freshDir("p-clean"));
  seedRecord(globalRoot, "facts", "leaked");
  assert.throws(() => assertEmptyRoots(sandboxOver(globalRoot, projectRoot)), /not empty/);
});

test("assertEmptyRoots throws when the project root holds a record (AC2)", () => {
  const globalRoot = memoryRootFor(freshDir("g-clean"));
  const projectRoot = memoryRootFor(freshDir("p-dirty"));
  seedRecord(projectRoot, "episodes", "leaked");
  assert.throws(() => assertEmptyRoots(sandboxOver(globalRoot, projectRoot)), /not empty/);
});

// --- AC3: two back-to-back prepares start byte-identical empty (no cross-run leak) ------------------

test("two back-to-back prepareSandbox calls start byte-identical empty with distinct paths (AC3)", () => {
  const first = trackSandbox(prepareSandbox("B"));
  const second = trackSandbox(prepareSandbox("B"));

  // byte-identical empty starting state
  assert.equal(countMemoryRecords(first.globalRoot), 0);
  assert.equal(countMemoryRecords(first.projectRoot), 0);
  assert.equal(countMemoryRecords(second.globalRoot), 0);
  assert.equal(countMemoryRecords(second.projectRoot), 0);

  // distinct paths → no shared state can leak between runs
  assert.notEqual(first.workingDir, second.workingDir);
  assert.notEqual(first.globalRoot, second.globalRoot);
  assert.notEqual(first.projectRoot, second.projectRoot);

  assert.doesNotThrow(() => assertNoCrossRunLeak(first, second));
});

test("assertNoCrossRunLeak throws when two runs would share a root (AC3 guard)", () => {
  const shared = trackSandbox(prepareSandbox("B"));
  // same paths reused for the second "run" → a leak the assertion must catch.
  const reused: Sandbox = { ...shared };
  assert.throws(() => assertNoCrossRunLeak(shared, reused), /Cross-run leak/);
});

// --- AC4: withholdGrader copies the task tree but never the grader/ suite ---------------------------

/** Build a task fixture: task inputs + a grader/ subdir holding the hidden answer key. */
function makeTaskFixture(): string {
  const fixture = freshDir("fixture");
  writeFileSync(join(fixture, "README.md"), "the task");
  mkdirSync(join(fixture, "src"), { recursive: true });
  writeFileSync(join(fixture, "src", "stub.ts"), "export const x = 1;\n");
  const grader = join(fixture, GRADER_DIR);
  mkdirSync(grader, { recursive: true });
  writeFileSync(join(grader, "answer-key.test.ts"), "// the hidden suite — must NOT reach the agent\n");
  mkdirSync(join(grader, "nested"), { recursive: true });
  writeFileSync(join(grader, "nested", "secret.ts"), "// also hidden\n");
  return fixture;
}

test("withholdGrader copies the task inputs into the working dir (AC4)", () => {
  const fixture = makeTaskFixture();
  const sandbox = trackSandbox(prepareSandbox("B"));

  withholdGrader(fixture, sandbox);

  const tree = listTree(sandbox.workingDir);
  assert.ok(tree.includes("README.md"), "task README copied in");
  assert.ok(tree.includes("src/stub.ts"), "task source copied in");
});

test("withholdGrader leaves NO grader/ file anywhere in the working tree (AC4)", () => {
  const fixture = makeTaskFixture();
  const sandbox = trackSandbox(prepareSandbox("B"));

  withholdGrader(fixture, sandbox);

  const tree = listTree(sandbox.workingDir);
  assert.equal(existsSync(join(sandbox.workingDir, GRADER_DIR)), false, "no grader/ dir in the tree");
  const graderLeaks = tree.filter((p) => p === GRADER_DIR || p.startsWith(`${GRADER_DIR}/`));
  assert.deepEqual(graderLeaks, [], "no file under grader/ reachable by the agent");
});

test("withholdGrader throws on a missing task fixture (setup bug, not a silent no-op)", () => {
  const sandbox = trackSandbox(prepareSandbox("B"));
  assert.throws(() => withholdGrader("/does/not/exist", sandbox), /does not exist/);
});
