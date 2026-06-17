// The events adapter (T-C / ADR-002): the `events.jsonl` writer + the stdout progress formatter. One run's
// lifecycle is captured two ways from a single `emit` — (a) the durable, append-only `runs/<id>/events.jsonl`
// log (one JSON line per event, machine-readable), and (b) a terse human progress line written through an
// injected `out` sink (default stdout). The two are derived from the same `EvalEvent` so they never drift.
//
// SRP: this module only formats + appends; it owns no run state and never reads back the log. It is a thin I/O
// adapter over the pure `EvalEvent` type from `schema.ts` — the only effects are the append and the `out` call,
// both confined to `emit`. `formatProgressLine` is pure (no I/O) so it is unit-testable in isolation.

import { appendFileSync } from "node:fs";

import type { EvalEvent } from "./schema.ts";

/** The emitter port the probe seam (T-D) and CLI write through. One method: record a lifecycle event. */
export interface EvalEmitter {
  /** Append `event` to the run's `events.jsonl` AND surface a human progress line through the injected `out`. */
  emit(event: EvalEvent): void;
}

/** Sink for the human progress line. Mirrors `process.stdout.write` (takes the line, returns void). Injectable. */
type OutFn = (line: string) => void;

/** Default sink: write the line to stdout. A function (not `process.stdout.write` passed directly) so `this` binds. */
const writeStdout: OutFn = (line) => {
  process.stdout.write(line);
};

/**
 * Build an emitter bound to one run's `events.jsonl` (`runs/<id>/events.jsonl`).
 *
 * @param eventsPath  Absolute path to the run's append-only `events.jsonl`. `emit` uses `appendFileSync`, so the
 *                    file is created on first write and every later event is appended — never overwritten. The
 *                    parent `runs/<id>/` dir must already exist (the write side, T-B, creates it).
 * @param out         The human-progress sink; defaults to stdout. Injected so a test can capture lines instead.
 */
export function createEmitter(eventsPath: string, out: OutFn = writeStdout): EvalEmitter {
  return {
    emit(event: EvalEvent): void {
      // (a) Durable, append-only log: one compact JSON line per event.
      appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      // (b) Human progress: a terse formatted line through the injected sink.
      out(formatProgressLine(event));
    },
  };
}

/**
 * Format one event as a terse, readable stdout progress line (ADR-002). `detail` carries the specifics (the probe
 * fills it, e.g. `"12/30 webhooks → decompose (134s)"`); this only chooses the per-kind prefix and indentation:
 *
 *   run-started  → "▶ <detail>"
 *   task-started → "→ <detail>"
 *   task-done    → "  ✓ <detail>"   (indented under its task-started)
 *   gate-fired   → "⚠ <detail>"
 *   run-done     → "■ <detail>"
 *
 * Pure (no I/O). The trailing newline makes it a complete line for a `write`-style sink.
 */
export function formatProgressLine(event: EvalEvent): string {
  const prefix = PROGRESS_PREFIX[event.kind];
  return `${prefix}${event.detail}\n`;
}

/** Per-kind line prefix (includes indentation/spacing). Exhaustive over `EvalEvent["kind"]`. */
const PROGRESS_PREFIX: Record<EvalEvent["kind"], string> = {
  "run-started": "▶ ",
  "task-started": "→ ",
  "task-done": "  ✓ ",
  "gate-fired": "⚠ ",
  "run-done": "■ ",
};
