// Tests for the Runner port + the pinned data contract (T-004). ZERO API spend:
//  - `replay.ts` is exercised against committed fixtures (no `claude -p` ever runs).
//  - `live.ts`'s JSON→Cost mapping is unit-tested against a CAPTURED real result envelope (the persisted
//    R0b raw stream) — proving the modelUsage-summed mapping without a paid call. `live.ts`'s spawn path is
//    NOT invoked here (that would spend API and is out of scope for T-004).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { mapResultToCost } from "../src/runner/live.ts";
import { loadRunRecord, replayRunner, replaySequenceRunner } from "../src/runner/replay.ts";
import type { Cost, RunRecord } from "../src/types.ts";
import type { Invocation, Sandbox } from "../src/runner/port.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "replay");
// benchmark/test -> repo root is two levels up. The R0b raw stream is the captured real sample (no re-call).
const REPO_ROOT = resolve(HERE, "..", "..");
const R0B_RAW = join(REPO_ROOT, ".agentry", "work", "benchmark-harness", "findings", "R0b-raw-stream.jsonl");

/** A no-op invocation/sandbox — replay ignores them, so these only need to type-check. */
const INV: Invocation = { prompt: "noop", model: "test-model" };
const SANDBOX: Sandbox = { workingDir: "/tmp/x", globalRoot: "/tmp/g", projectRoot: "/tmp/p", env: {} };

/** Pull the single final `type:"result"` envelope out of the captured R0b stream. */
function capturedResultEnvelope(): Record<string, unknown> {
  const lines = readFileSync(R0B_RAW, "utf8").split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type === "result") return ev;
  }
  throw new Error("no type:result envelope in captured R0b stream");
}

// --- replay.ts: zero-API-spend path -----------------------------------------

test("replayRunner returns a recorded RunRecord with zero API calls", async () => {
  const runner = replayRunner(join(FIXTURES, "sample-run.json"));
  const rec = await runner.run(INV, SANDBOX);
  assert.equal(rec.cost.totalCostUsd, 0.40430575);
  assert.equal(rec.cost.numTurns, 2);
  assert.deepEqual(rec.producedTree, ["src/index.ts", "src/util.ts"]);
  assert.deepEqual(rec.usedMemories, ["fact:date-formatter-drops-tz"]);
});

test("loadRunRecord reads and parses a fixture into a RunRecord", () => {
  const rec: RunRecord = loadRunRecord(join(FIXTURES, "sample-run.json"));
  assert.equal(rec.cost.inputTokens, 18071);
  assert.equal(rec.cost.cacheCreationInputTokens, 32455);
});

test("replaySequenceRunner returns fixtures in order, one per run() call", async () => {
  const runner = replaySequenceRunner([
    join(FIXTURES, "null-cold-b-run1.json"),
    join(FIXTURES, "null-cold-b-run2.json"),
  ]);
  const r1 = await runner.run(INV, SANDBOX);
  const r2 = await runner.run(INV, SANDBOX);
  assert.equal(r1.cost.totalCostUsd, 0.2);
  assert.equal(r2.cost.totalCostUsd, 0.205);
});

test("replaySequenceRunner throws when exhausted (no silent fixture reuse)", async () => {
  const runner = replaySequenceRunner([join(FIXTURES, "null-cold-b-run1.json")]);
  await runner.run(INV, SANDBOX);
  await assert.rejects(() => runner.run(INV, SANDBOX), /exhausted/);
});

// --- AC13 honest-null fixture pair ------------------------------------------

test("an AC13 null-proof fixture pair exists with equivalent cold(B) and warm(C) arms", () => {
  const b = [
    loadRunRecord(join(FIXTURES, "null-cold-b-run1.json")),
    loadRunRecord(join(FIXTURES, "null-cold-b-run2.json")),
  ];
  const c = [
    loadRunRecord(join(FIXTURES, "null-warm-c-run1.json")),
    loadRunRecord(join(FIXTURES, "null-warm-c-run2.json")),
  ];
  const mean = (xs: RunRecord[]): number =>
    xs.reduce((s, r) => s + r.cost.totalCostUsd, 0) / xs.length;
  // The arms perform equivalently → C−B delta sits well inside the spread → T-009 must report a non-win.
  const delta = Math.abs(mean(c) - mean(b));
  assert.ok(delta < 0.01, `expected an equivalent (near-zero) C−B delta, got ${delta}`);
  // Both arms produce the same tree → no AC-pass-rate edge either.
  assert.deepEqual(b[0]!.producedTree, c[0]!.producedTree);
});

// --- live.ts: JSON→Cost mapping against the CAPTURED real sample (no API call) -----

test("mapResultToCost populates every Cost field non-null from the captured real envelope", () => {
  const cost: Cost = mapResultToCost(capturedResultEnvelope());
  for (const [field, value] of Object.entries(cost)) {
    assert.equal(typeof value, "number", `${field} should be a number`);
    assert.notEqual(value, null, `${field} must not be null`);
  }
  // Every token field is strictly positive in the real sample (AC5: no missing field reads as 0/null).
  assert.ok(cost.inputTokens > 0);
  assert.ok(cost.outputTokens > 0);
  assert.ok(cost.cacheReadInputTokens > 0);
  assert.ok(cost.cacheCreationInputTokens > 0);
  assert.ok(cost.totalCostUsd > 0);
  assert.ok(cost.numTurns > 0);
});

test("mapResultToCost takes the token axis from modelUsage, NOT parent-only usage.* (R0b)", () => {
  const envelope = capturedResultEnvelope();
  const cost = mapResultToCost(envelope);
  const modelUsage = (envelope.modelUsage as Record<string, Record<string, number>>)[
    "claude-opus-4-8[1m]"
  ]!;
  const usage = envelope.usage as Record<string, number>;

  // Mapped tokens equal the modelUsage block (the subagent-inclusive axis)...
  assert.equal(cost.inputTokens, modelUsage.inputTokens);
  assert.equal(cost.outputTokens, modelUsage.outputTokens);
  assert.equal(cost.cacheReadInputTokens, modelUsage.cacheReadInputTokens);
  assert.equal(cost.cacheCreationInputTokens, modelUsage.cacheCreationInputTokens);

  // ...and are NOT the parent-only usage.* totals (which undercount the subagent tax — the AC6 trap).
  const parentCacheRead = usage.cache_read_input_tokens ?? 0;
  assert.notEqual(cost.cacheReadInputTokens, parentCacheRead);
  assert.ok(
    cost.cacheReadInputTokens > parentCacheRead,
    "modelUsage cacheRead must exceed parent-only usage cacheRead (subagent tax included)",
  );

  // Cost axis = total_cost_usd; turns = num_turns (from the same envelope).
  assert.equal(cost.totalCostUsd, envelope.total_cost_usd);
  assert.equal(cost.numTurns, envelope.num_turns);
});

test("mapResultToCost sums modelUsage across MULTIPLE model keys (R0b multi-model note)", () => {
  const cost = mapResultToCost({
    num_turns: 1,
    total_cost_usd: 0.5,
    duration_ms: 100,
    modelUsage: {
      "model-a": { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 100, cacheCreationInputTokens: 5 },
      "model-b": { inputTokens: 20, outputTokens: 2, cacheReadInputTokens: 200, cacheCreationInputTokens: 7 },
    },
  });
  assert.equal(cost.inputTokens, 30);
  assert.equal(cost.outputTokens, 3);
  assert.equal(cost.cacheReadInputTokens, 300);
  assert.equal(cost.cacheCreationInputTokens, 12);
});

test("mapResultToCost prefers the runner's own wall-clock over envelope duration_ms when provided", () => {
  const cost = mapResultToCost({ num_turns: 1, total_cost_usd: 0, duration_ms: 5000, modelUsage: {} }, 7777);
  assert.equal(cost.durationMs, 7777);
});
