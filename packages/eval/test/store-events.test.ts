// Tests for the events adapter (T-C / ADR-002). The emitter has two observable effects per `emit`: an appended
// JSON line on `events.jsonl`, and a formatted progress line through the injected `out`. We assert both via an
// injected sink + a temp `eventsPath` (no stdout coupling, no API spend), and that multiple emits append rather
// than overwrite. `formatProgressLine` is exercised directly as the pure unit it is.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createEmitter, formatProgressLine } from "../src/store/events.ts";
import type { EvalEvent } from "../src/store/schema.ts";

function tmpEventsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "selfeval-events-"));
  return join(dir, "events.jsonl");
}

const SAMPLE: EvalEvent = {
  kind: "task-done",
  runId: "r",
  detail: "12/30 webhooks → decompose (134s)",
  ts: "2026-06-17T00:00:00.000Z",
};

// --- emit: durable log + progress line --------------------------------------------------------------------

test("emit appends exactly one parseable JSON line equal to the event AND emits a progress line with the detail", () => {
  const eventsPath = tmpEventsPath();
  const out: string[] = [];

  createEmitter(eventsPath, (line) => out.push(line)).emit(SAMPLE);

  // (a) events.jsonl gained exactly one line, parseable and deep-equal to the event.
  const lines = readFileSync(eventsPath, "utf8").split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), SAMPLE);

  // (b) out received one formatted progress line carrying the detail.
  assert.equal(out.length, 1);
  assert.ok(out[0]!.includes(SAMPLE.detail), `progress line missing detail: ${out[0]}`);
});

test("multiple emits append to events.jsonl (do not overwrite) — one JSON line per event, in order", () => {
  const eventsPath = tmpEventsPath();
  const out: string[] = [];
  const emitter = createEmitter(eventsPath, (line) => out.push(line));

  const a: EvalEvent = { kind: "run-started", runId: "r", detail: "first", ts: "2026-06-17T00:00:00.000Z" };
  const b: EvalEvent = { kind: "task-started", runId: "r", detail: "second", ts: "2026-06-17T00:00:01.000Z" };
  const c: EvalEvent = { kind: "run-done", runId: "r", detail: "third", ts: "2026-06-17T00:00:02.000Z" };
  emitter.emit(a);
  emitter.emit(b);
  emitter.emit(c);

  const events = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EvalEvent);
  assert.equal(events.length, 3);
  assert.deepEqual(events, [a, b, c]);
  assert.equal(out.length, 3);
});

// --- formatProgressLine: pure per-kind formatting ---------------------------------------------------------

test("formatProgressLine marks task-done with a check and the detail, ending in a newline", () => {
  const line = formatProgressLine(SAMPLE);
  assert.match(line, /✓/);
  assert.ok(line.includes(SAMPLE.detail));
  assert.ok(line.endsWith("\n"));
});

test("formatProgressLine gives every event kind a distinct, detail-bearing prefix", () => {
  const kinds: EvalEvent["kind"][] = ["run-started", "task-started", "task-done", "gate-fired", "run-done"];
  const lines = kinds.map((kind) => formatProgressLine({ kind, runId: "r", detail: `d-${kind}`, ts: "t" }));

  // Each line carries its own detail and ends in a newline.
  for (let i = 0; i < kinds.length; i++) {
    assert.ok(lines[i]!.includes(`d-${kinds[i]}`));
    assert.ok(lines[i]!.endsWith("\n"));
  }
  // The prefixes (line minus detail+newline) are all distinct — a reader can tell the kinds apart at a glance.
  const prefixes = lines.map((line, i) => line.replace(`d-${kinds[i]}\n`, ""));
  assert.equal(new Set(prefixes).size, kinds.length);
});
