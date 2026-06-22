// Tests for the PRODUCED-RESULT reader (ADR-002 / ADR-001 capture-step consumer / AC2) — the PURE, oracle-free
// rendering of an agent-visible sandbox tree into the judge's input. ZERO API: the reader only touches the
// filesystem, so the tests build a throwaway sandbox, render it, and assert the contract: produced files are
// included, the `oracle/` subtree is NOT, the rendering is deterministic (sorted), and an oversized tree is
// size-capped (the bound that keeps a large tree out of the judge prompt / cost).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { summarizeProducedResult } from "../src/conduct/result.ts";
import type { OutcomeFixture } from "../src/conduct/fixture.ts";

/** A minimal fixture stub — the reader consumes only `fixture.id`; the rest is unused by this slice. */
function fixtureStub(id: string): OutcomeFixture {
  return {
    id,
    prompt: "stub task",
    shape: "spec-first",
    kind: "feature",
    oracleCmd: "node --test oracle/",
    oracleTimeoutMs: 60_000,
    seedDir: "/unused/seed",
    oracleDir: "/unused/oracle",
    goldenDir: "/unused/golden",
    brokenDir: "/unused/broken",
  };
}

/** Make a fresh temp sandbox dir; the caller writes the produced tree into it. */
function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), "outcome-judge-result-"));
}

/** Write a file under `sandboxDir`, creating parent dirs. `rel` is a posix-style relative path. */
function write(sandboxDir: string, rel: string, content: string): void {
  const abs = join(sandboxDir, ...rel.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// --- happy path: produced files are rendered, deterministically and sorted -------------------------------------

test("summarizeProducedResult: includes the produced files with their contents", () => {
  const sandbox = makeSandbox();
  try {
    write(sandbox, "src/slugify.js", "export const slugify = (s) => s;");
    write(sandbox, "README.md", "# task");

    const result = summarizeProducedResult(sandbox, fixtureStub("slugify-feature"));

    assert.equal(result.fixtureId, "slugify-feature");
    assert.deepEqual(result.files, ["README.md", "src/slugify.js"]); // sorted, posix-style
    assert.match(result.text, /export const slugify/);
    assert.match(result.text, /# task/);
    assert.equal(result.truncated, false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("summarizeProducedResult: output is deterministic (file order does not depend on write order)", () => {
  const a = makeSandbox();
  const b = makeSandbox();
  try {
    // Same tree, opposite write order — the rendering must be byte-identical.
    write(a, "z.js", "z");
    write(a, "a.js", "a");
    write(b, "a.js", "a");
    write(b, "z.js", "z");

    const ra = summarizeProducedResult(a, fixtureStub("fx"));
    const rb = summarizeProducedResult(b, fixtureStub("fx"));

    assert.equal(ra.text, rb.text);
    assert.deepEqual(ra.files, ["a.js", "z.js"]);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

// --- oracle exclusion: the held-out subtree is never in the judged input (AC2 / AC5) --------------------------

test("summarizeProducedResult: EXCLUDES the oracle/ subtree entirely", () => {
  const sandbox = makeSandbox();
  try {
    write(sandbox, "src/index.js", "export const ok = true;");
    // The injected held-out oracle — must NOT appear in the rendering.
    write(sandbox, "oracle/index.test.js", "test('secret oracle assertion', () => {});");
    write(sandbox, "oracle/nested/deep.test.js", "// secret oracle helper");

    const result = summarizeProducedResult(sandbox, fixtureStub("fx"));

    assert.deepEqual(result.files, ["src/index.js"]);
    assert.ok(!result.files.some((f) => f.startsWith("oracle/")), "no oracle/ path may be listed");
    assert.doesNotMatch(result.text, /secret oracle/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("summarizeProducedResult: a root file named oracle.js is KEPT (only the oracle/ dir is excluded)", () => {
  const sandbox = makeSandbox();
  try {
    write(sandbox, "oracle.js", "export const notTheHeldOut = 1;");
    write(sandbox, "oracle/index.test.js", "// the real held-out tree");

    const result = summarizeProducedResult(sandbox, fixtureStub("fx"));

    assert.deepEqual(result.files, ["oracle.js"]);
    assert.match(result.text, /notTheHeldOut/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// --- size cap: an oversized tree is bounded (the judge-cost guard) ---------------------------------------------

test("summarizeProducedResult: caps a single oversized file's contents", () => {
  const sandbox = makeSandbox();
  try {
    const huge = "x".repeat(50_000);
    write(sandbox, "big.js", huge);

    const result = summarizeProducedResult(sandbox, fixtureStub("fx"), { maxFileBytes: 1_000 });

    assert.equal(result.truncated, true);
    assert.match(result.text, /\[truncated: file exceeds 1000 bytes\]/);
    // The full 50k content must NOT be present — the cap actually bounds the rendering.
    assert.ok(result.text.length < huge.length, "rendered text must be smaller than the raw oversized file");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("summarizeProducedResult: caps total size across many files (judge-cost bound)", () => {
  const sandbox = makeSandbox();
  try {
    // 20 files × ~2k each = ~40k of content; cap the total well below that.
    const chunk = "y".repeat(2_000);
    for (let i = 0; i < 20; i++) {
      write(sandbox, `f${String(i).padStart(2, "0")}.js`, chunk);
    }

    const result = summarizeProducedResult(sandbox, fixtureStub("fx"), {
      maxFileBytes: 5_000,
      maxTotalBytes: 10_000,
    });

    assert.equal(result.truncated, true);
    // All files are still LISTED (the judge knows they exist) ...
    assert.equal(result.files.length, 20);
    // ... but the rendered text is bounded near the total cap, not the full ~40k.
    assert.ok(result.text.length < 20_000, `text length ${result.text.length} should be bounded near the cap`);
    assert.match(result.text, /\[omitted: total size cap reached\]/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
