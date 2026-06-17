// Tests for the WRITE side of the artifact store (write.ts / T-B). Pure fs, ZERO API spend: it builds a fake
// sandbox tree in a temp dir, drives the full run lifecycle (beginRun → captureTask → finishRun) into a temp
// runs-root, and asserts the on-disk tree (ADR-001) landed with correct paths and content. Covers the keystone
// `.agentry/work/` copy, the `.r<i>` multi-run suffix, and the missing-work-folder tolerance.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createRunStore } from "../src/store/write.ts";
import { SCHEMA_VERSION } from "../src/store/schema.ts";
import type { RunConfig, RunSummary } from "../src/store/schema.ts";

/**
 * Build a fake task sandbox on disk: a `.agentry/work/x/spec.md` artifact tree + a `stream.jsonl`.
 * Returns the sandbox dir and the absolute stream path the capture copies out.
 */
function makeSandbox(): { sandboxDir: string; streamPath: string } {
  const sandboxDir = mkdtempSync(join(tmpdir(), "selfeval-write-sandbox-"));
  mkdirSync(join(sandboxDir, ".agentry", "work", "x"), { recursive: true });
  writeFileSync(join(sandboxDir, ".agentry", "work", "x", "spec.md"), "# spec\nhello\n", "utf8");
  const streamPath = join(sandboxDir, "stream.jsonl");
  writeFileSync(streamPath, `{"event":"start"}\n{"event":"done"}\n`, "utf8");
  return { sandboxDir, streamPath };
}

function makeConfig(runId: string): RunConfig {
  return { runId, kind: "routing", startedAt: "2026-06-17T00:00:00.000Z" };
}

function makeSummary(runId: string, config: RunConfig, taskCount: number): RunSummary {
  return {
    runId,
    kind: "routing",
    schemaVersion: SCHEMA_VERSION,
    config,
    taskCount,
    finishedAt: "2026-06-17T00:01:00.000Z",
    artifact: { score: 1, verbatim: true },
  };
}

test("a full run round-trips the ADR-001 tree to disk with correct paths and content", () => {
  const { sandboxDir, streamPath } = makeSandbox();
  const runsRoot = mkdtempSync(join(tmpdir(), "selfeval-write-runs-"));
  const config = makeConfig("test-run");

  const store = createRunStore(runsRoot, "test-run");
  store.beginRun(config);
  store.captureTask({ taskId: "t1", sandboxDir, streamPath, shape: "spec-first", timingMs: 123 });
  store.finishRun(makeSummary("test-run", config, 1));

  const base = join(runsRoot, "test-run");

  // config.json — the reproducibility header, stored verbatim.
  assert.deepEqual(JSON.parse(readFileSync(join(base, "config.json"), "utf8")), config);

  // summary.json — wraps the probe artifact verbatim.
  const summary = JSON.parse(readFileSync(join(base, "summary.json"), "utf8"));
  assert.equal(summary.taskCount, 1);
  assert.deepEqual(summary.artifact, { score: 1, verbatim: true });

  // tasks/t1/ — single-run task keeps a bare dir name (no `.r<i>` suffix).
  const taskDir = join(base, "tasks", "t1");
  assert.equal(readFileSync(join(taskDir, "stream.jsonl"), "utf8"), `{"event":"start"}\n{"event":"done"}\n`);
  assert.deepEqual(JSON.parse(readFileSync(join(taskDir, "shape.json"), "utf8")), { shape: "spec-first" });
  assert.deepEqual(JSON.parse(readFileSync(join(taskDir, "timing.json"), "utf8")), { timingMs: 123 });

  // the keystone: the `.agentry/work/` tree copied to `tasks/t1/work/` (AC3 later reads this).
  assert.equal(readFileSync(join(taskDir, "work", "x", "spec.md"), "utf8"), "# spec\nhello\n");
});

test("captureTask with runIndex defined writes a `.r<i>`-suffixed task dir (multi-run disambiguation)", () => {
  const { sandboxDir, streamPath } = makeSandbox();
  const runsRoot = mkdtempSync(join(tmpdir(), "selfeval-write-runs-"));

  const store = createRunStore(runsRoot, "multi-run");
  store.beginRun(makeConfig("multi-run"));
  store.captureTask({ taskId: "t1", runIndex: 0, sandboxDir, streamPath, shape: "one-shot", timingMs: 50 });

  const taskDir = join(runsRoot, "multi-run", "tasks", "t1.r0");
  assert.ok(existsSync(taskDir), "expected tasks/t1.r0/ to exist");
  assert.ok(!existsSync(join(runsRoot, "multi-run", "tasks", "t1")), "bare tasks/t1/ must NOT exist when runIndex given");
  assert.deepEqual(JSON.parse(readFileSync(join(taskDir, "shape.json"), "utf8")), { shape: "one-shot" });
});

test("captureTask tolerates a missing `.agentry/work` folder (one-shot task, no artifact) without throwing", () => {
  // A sandbox with a stream but NO `.agentry/work` tree — a one-shot task that produced no work folder.
  const sandboxDir = mkdtempSync(join(tmpdir(), "selfeval-write-nowork-"));
  const streamPath = join(sandboxDir, "stream.jsonl");
  writeFileSync(streamPath, `{"event":"done"}\n`, "utf8");
  const runsRoot = mkdtempSync(join(tmpdir(), "selfeval-write-runs-"));

  const store = createRunStore(runsRoot, "nowork-run");
  store.beginRun(makeConfig("nowork-run"));

  assert.doesNotThrow(() =>
    store.captureTask({ taskId: "t1", sandboxDir, streamPath, shape: "one-shot", timingMs: 10 }),
  );

  const taskDir = join(runsRoot, "nowork-run", "tasks", "t1");
  // The stream still copied; no `work/` dir was created (nothing to copy).
  assert.equal(readFileSync(join(taskDir, "stream.jsonl"), "utf8"), `{"event":"done"}\n`);
  assert.ok(!existsSync(join(taskDir, "work")), "no work/ dir should exist when the sandbox has no .agentry/work");
});

test("captureTask tolerates a missing streamPath (replay-driven capture, no stream teed) without throwing", () => {
  // A sandbox with a `.agentry/work` tree but NO `stream.jsonl` — a replay-driven capture that never teed a stream.
  const sandboxDir = mkdtempSync(join(tmpdir(), "selfeval-write-nostream-"));
  mkdirSync(join(sandboxDir, ".agentry", "work", "x"), { recursive: true });
  writeFileSync(join(sandboxDir, ".agentry", "work", "x", "spec.md"), "# spec\nhi\n", "utf8");
  const streamPath = join(sandboxDir, "stream.jsonl"); // deliberately NOT written.
  const runsRoot = mkdtempSync(join(tmpdir(), "selfeval-write-runs-"));

  const store = createRunStore(runsRoot, "nostream-run");
  store.beginRun(makeConfig("nostream-run"));

  assert.doesNotThrow(() =>
    store.captureTask({ taskId: "t1", sandboxDir, streamPath, shape: "spec-first", timingMs: 10 }),
  );

  const taskDir = join(runsRoot, "nostream-run", "tasks", "t1");
  // No stream copied (the source didn't exist), but shape.json + the work/ tree still landed.
  assert.ok(!existsSync(join(taskDir, "stream.jsonl")), "no stream.jsonl should exist when the source stream is absent");
  assert.deepEqual(JSON.parse(readFileSync(join(taskDir, "shape.json"), "utf8")), { shape: "spec-first" });
  assert.equal(readFileSync(join(taskDir, "work", "x", "spec.md"), "utf8"), "# spec\nhi\n");
});
