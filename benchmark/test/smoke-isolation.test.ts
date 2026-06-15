// Unit tests for the R0 byte-empty-roots assertion logic (Task T-003 AC3). No API call: the assertion
// is exercised against fixture dir pairs so we trust it before spending the one real `claude -p` run.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { rmSync } from "node:fs";
import {
  countMemoryRecords,
  memoryRootFor,
  rootsAreEmpty,
  runSucceeded,
} from "../src/smoke/isolation.ts";

const made: string[] = [];
function freshBase(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `r0-test-${label}-`));
  made.push(d);
  return d;
}
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** Write a record `.md` under <base>/.agentry/memory/<kind>/ (mirrors file-store's layout). */
function seedRecord(base: string, kind: "facts" | "episodes", name: string): void {
  const dir = join(memoryRootFor(base), kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), "---\nid: x\n---\n\nbody\n");
}

test("memoryRootFor appends .agentry/memory to the base dir", () => {
  assert.equal(memoryRootFor("/tmp/x"), join("/tmp/x", ".agentry", "memory"));
});

test("countMemoryRecords returns 0 for a base whose memory root does not exist", () => {
  const base = freshBase("missing"); // fresh temp dir, no .agentry/memory created
  assert.equal(countMemoryRecords(memoryRootFor(base)), 0);
});

test("countMemoryRecords returns 0 for empty facts/ and episodes/ dirs", () => {
  const base = freshBase("emptydirs");
  mkdirSync(join(memoryRootFor(base), "facts"), { recursive: true });
  mkdirSync(join(memoryRootFor(base), "episodes"), { recursive: true });
  assert.equal(countMemoryRecords(memoryRootFor(base)), 0);
});

test("countMemoryRecords counts .md records across facts and episodes", () => {
  const base = freshBase("seeded");
  seedRecord(base, "facts", "a-fact");
  seedRecord(base, "facts", "b-fact");
  seedRecord(base, "episodes", "c-episode");
  assert.equal(countMemoryRecords(memoryRootFor(base)), 3);
});

test("countMemoryRecords ignores non-.md files (only record files count)", () => {
  const base = freshBase("nonmd");
  const dir = join(memoryRootFor(base), "facts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.db"), "binary");
  writeFileSync(join(dir, ".gitkeep"), "");
  assert.equal(countMemoryRecords(memoryRootFor(base)), 0);
});

test("rootsAreEmpty is true for a fresh fixture pair of empty dirs (the positive case)", () => {
  const globalBase = freshBase("g-empty");
  const projectBase = freshBase("p-empty");
  assert.equal(rootsAreEmpty(globalBase, projectBase), true);
});

test("rootsAreEmpty is false when the global root holds a record", () => {
  const globalBase = freshBase("g-dirty");
  const projectBase = freshBase("p-clean");
  seedRecord(globalBase, "facts", "leaked");
  assert.equal(rootsAreEmpty(globalBase, projectBase), false);
});

test("rootsAreEmpty is false when the project root holds a record", () => {
  const globalBase = freshBase("g-clean2");
  const projectBase = freshBase("p-dirty");
  seedRecord(projectBase, "episodes", "leaked");
  assert.equal(rootsAreEmpty(globalBase, projectBase), false);
});

test("runSucceeded is true only for a non-error envelope with a result string", () => {
  assert.equal(runSucceeded({ is_error: false, result: "hi there" }), true);
});

test("runSucceeded is false for an error envelope (auth failure must not read as success)", () => {
  assert.equal(runSucceeded({ is_error: true, result: "Invalid API key" }), false);
});

test("runSucceeded is false for a missing/empty result (no false positive on empty output)", () => {
  assert.equal(runSucceeded({ is_error: false }), false);
  assert.equal(runSucceeded({ is_error: false, result: "" }), false);
});
