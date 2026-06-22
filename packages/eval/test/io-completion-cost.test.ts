// Tests for the run-to-completion mode + cost capture extension to the shared io seam (ADR-002, T2). ZERO API
// spend: the streaming branch is driven by a FAKE CHILD emitting a synthetic NDJSON stream (no `claude -p`
// ever runs). Two behaviors are proved here:
//   - `Invocation.runToCompletion` takes NEITHER early-kill path: a stream with an `Agent` dispatch followed by
//     a settle is NOT killed on dispatch (and the artifact poll is suppressed too).
//   - The settled `result` envelope's `usage`/`total_cost_usd`/`duration_ms`/`num_turns` populate
//     `RunResult.cost`; a killed/absent run leaves `cost` undefined (no throw).
//
// Mirrors capture-stream.test.ts's FakeChild harness. The cost field names are PINNED against a real captured
// `claude -p --output-format stream-json` `result` event (a synthetic sample of that exact shape is used here).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCaptured } from "../src/io/live.ts";
import type { SpawnFn, StreamChild } from "../src/io/live.ts";
import type { Invocation, Sandbox } from "../src/io/port.ts";

/** A fake `claude` child (see capture-stream.test.ts): records `kill()`, closes naturally if never killed. */
class FakeChild extends EventEmitter implements StreamChild {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killCount = 0;

  kill = (): boolean => {
    this.killCount += 1;
    queueMicrotask(() => this.emit("close", null));
    return true;
  };

  feed(chunks: string[]): void {
    for (const c of chunks) this.stdout.emit("data", c);
    if (this.killCount === 0) queueMicrotask(() => this.emit("close", 0));
  }
}

/** An `assistant` event carrying a `tool_use name:"Agent"` block — the dispatch that kills in the default mode. */
const AGENT_DISPATCH_LINE =
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { subagent_type: "x" } }] },
  }) + "\n";

/**
 * A settled `result` envelope with the EXACT field shape a real `claude -p --output-format stream-json` run
 * emits (snake_case `usage.*` + `total_cost_usd`/`duration_ms`/`num_turns`). Extra fields the parser ignores
 * (`modelUsage`, `usage.cache_creation_input_tokens`, …) are included to model the real envelope faithfully.
 */
const RESULT_WITH_COST_LINE =
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 38059,
    num_turns: 6,
    total_cost_usd: 0.485633,
    usage: {
      input_tokens: 18382,
      cache_creation_input_tokens: 27106,
      cache_read_input_tokens: 146626,
      output_tokens: 1974,
    },
  }) + "\n";

/** A settled `result` envelope with NO usage/cost fields — a present-but-empty cost record (e.g. an old CLI). */
const RESULT_NO_COST_LINE =
  JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\n";

function freshSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "selfeval-completion-"));
  return { workingDir: dir, globalRoot: dir, projectRoot: dir, env: {} };
}

function streamFileIn(sandbox: Sandbox): string {
  return join(sandbox.workingDir, "stream.jsonl");
}

// --- runToCompletion: a dispatch does NOT kill; the run settles on its result envelope ------------------

test("runToCompletion lets a dispatch run on to settle, never killing on the first Agent dispatch", async () => {
  const sandbox = freshSandbox();
  const streamPath = streamFileIn(sandbox);
  const child = new FakeChild();
  const spawnFn: SpawnFn = () => child;

  const inv: Invocation = { prompt: "noop", model: "test-model", streamPath, runToCompletion: true };

  const runPromise = runCaptured(inv, sandbox, spawnFn);
  // A dispatch (would kill in default mode) is followed by a settle — run-to-completion must NOT kill.
  child.feed([AGENT_DISPATCH_LINE, RESULT_WITH_COST_LINE]);
  const record = await runPromise;

  assert.equal(child.killCount, 0, "run-to-completion must NOT kill on dispatch — the build runs to settle");
  assert.equal(record.resultSubtype, "success", "a settled run-to-completion run surfaces result.subtype");
});

// --- cost parse: a settled result envelope's usage/cost populate RunResult.cost ------------------------

test("a settled result envelope populates RunResult.cost from usage/total_cost_usd/duration_ms/num_turns", async () => {
  const sandbox = freshSandbox();
  const streamPath = streamFileIn(sandbox);
  const child = new FakeChild();
  const spawnFn: SpawnFn = () => child;

  const inv: Invocation = { prompt: "noop", model: "test-model", streamPath, runToCompletion: true };

  const runPromise = runCaptured(inv, sandbox, spawnFn);
  child.feed([RESULT_WITH_COST_LINE]);
  const record = await runPromise;

  assert.deepEqual(record.cost, {
    inputTokens: 18382,
    outputTokens: 1974,
    cacheReadTokens: 146626,
    totalCostUsd: 0.485633,
    durationMs: 38059,
    numTurns: 6,
  });
});

// --- a settled envelope with no usage fields yields a present-but-empty cost (no throw) ----------------

test("a settled result envelope with no usage/cost fields yields an empty cost object, not a throw", async () => {
  const sandbox = freshSandbox();
  const streamPath = streamFileIn(sandbox);
  const child = new FakeChild();
  const spawnFn: SpawnFn = () => child;

  const inv: Invocation = { prompt: "noop", model: "test-model", streamPath, runToCompletion: true };

  const runPromise = runCaptured(inv, sandbox, spawnFn);
  child.feed([RESULT_NO_COST_LINE]);
  const record = await runPromise;

  // The run settled (so cost is "known"), but the envelope carried no numeric fields → an empty record.
  assert.deepEqual(record.cost, {});
});

// --- a killed run forfeits its result envelope → cost is undefined (no throw) --------------------------

test("a killed run (no settled result envelope) leaves RunResult.cost undefined", async () => {
  const sandbox = freshSandbox();
  const streamPath = streamFileIn(sandbox);
  const child = new FakeChild();
  const spawnFn: SpawnFn = () => child;

  // Default mode (no runToCompletion): the Agent dispatch kills the run before any result envelope arrives.
  const inv: Invocation = { prompt: "noop", model: "test-model", streamPath };

  const runPromise = runCaptured(inv, sandbox, spawnFn);
  child.feed([AGENT_DISPATCH_LINE]);
  const record = await runPromise;

  assert.equal(child.killCount, 1, "default mode still kills on dispatch — run-to-completion is opt-in only");
  assert.equal(record.cost, undefined, "a killed run carries no cost");
  assert.equal(record.resultSubtype, undefined, "a killed run forfeits the trailing result envelope");
});
