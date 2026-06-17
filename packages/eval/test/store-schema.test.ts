// Tests for the store's typed contract + run-id (T-A / ADR-001). ZERO API spend: pure id-string assertions and
// a type-shape compile check. The run-id behavior is the testable logic here; the schema types are exercised by
// constructing a value typed as each exported shape (so a sibling task that mis-binds a field is caught at author
// time, and the assertions confirm the values round-trip).

import assert from "node:assert/strict";
import { test } from "node:test";

import { newRunId } from "../src/store/runId.ts";
import type {
  RunConfig,
  TaskRecord,
  RunSummary,
  TaskCaptureSrc,
  EvalObserver,
} from "../src/store/schema.ts";
import { SCHEMA_VERSION } from "../src/store/schema.ts";

// --- newRunId -----------------------------------------------------------------------------------------------

test("newRunId returns the override verbatim when one is given (deterministic for replay/tests)", () => {
  assert.equal(newRunId("fixed-id"), "fixed-id");
});

test("newRunId generates a YYYYMMDD-HHMMSS-<rand4> id when no override is given", () => {
  const id = newRunId();
  assert.match(id, /^\d{8}-\d{6}-[a-z0-9]{4}$/);
});

test("newRunId generated ids are unique across calls (random suffix disambiguates same-second runs)", () => {
  const a = newRunId();
  const b = newRunId();
  // Same second is likely; the rand4 suffix must still make them distinct.
  assert.notEqual(a, b);
});

// --- schema types compile + carry the pinned fields ---------------------------------------------------------

test("the exported schema types compile and carry their pinned fields", () => {
  const config: RunConfig = {
    runId: "fixed-id",
    kind: "routing",
    fixtureDir: "fixtures/routing",
    k: 3,
    runs: 1,
    model: "claude-opus-4-8[1m]",
    pluginDir: "/plugin",
    startedAt: "2026-06-17T00:00:00.000Z",
  };

  const record: TaskRecord = {
    taskId: "routing-token-ttl",
    runIndex: 0,
    labeledFloor: "spec-first",
    shape: "spec-first",
    timingMs: 134000,
  };

  const captureSrc: TaskCaptureSrc = {
    taskId: "routing-token-ttl",
    runIndex: 0,
    sandboxDir: "/tmp/sandbox-abc",
    streamPath: "/tmp/sandbox-abc/stream.jsonl",
    shape: "spec-first",
    timingMs: 134000,
  };

  const summary: RunSummary = {
    runId: "fixed-id",
    kind: "routing",
    schemaVersion: SCHEMA_VERSION,
    config,
    taskCount: 1,
    finishedAt: "2026-06-17T00:01:00.000Z",
    artifact: { anything: "stored verbatim" },
  };

  // EvalObserver: both hooks optional; the recorded sink proves the seam shape T-D writes through.
  const emitted: string[] = [];
  const captured: TaskCaptureSrc[] = [];
  const observer: EvalObserver = {
    emit: (event) => emitted.push(event.kind),
    onTaskComplete: (src) => captured.push(src),
  };
  observer.emit?.({ kind: "task-done", runId: "fixed-id", detail: "task complete", ts: "2026-06-17T00:00:00.000Z" });
  observer.onTaskComplete?.(captureSrc);

  // SCHEMA_VERSION is a string const (so a future "2.1" scheme stays representable).
  assert.equal(typeof SCHEMA_VERSION, "string");
  // The values round-trip through their typed shapes.
  assert.equal(config.runId, "fixed-id");
  assert.equal(record.shape, "spec-first");
  assert.equal(summary.taskCount, 1);
  assert.deepEqual(emitted, ["task-done"]);
  assert.equal(captured[0]?.taskId, "routing-token-ttl");

  // An empty observer is valid (both hooks optional) — the AC5 default-no-op shape.
  const noop: EvalObserver = {};
  assert.equal(noop.emit, undefined);
  assert.equal(noop.onTaskComplete, undefined);
});
