// FlowEvent — the closed, discriminated conductor event vocabulary (ADR-002). Pure shapes, no I/O.
// Lives in FLOW's domain (NOT @agentry/core): core's `WorkEvent` is deliberately loose so the
// dep-free hook can write it; FLOW needs a *closed* union the loose shape can't express. Consumed by
// T03's monitoring service (`event_emit`/`event_tail`/`run_status`).
//
// One append-only `events.jsonl` carries TWO line shapes (ADR-002): FLOW lines (a discriminated
// `type`) and legacy backstop lines from the `subagent-emit` hook (a loose `kind`, no `type`).
// `parseLogLine` is the typed-vs-legacy discriminator the reader uses to tell them apart.
import { z } from "zod";

// ---- FLOW-emitted lines: the closed conductor vocabulary (ADR-002 table) ----

// A routing decision: which shape the conductor chose for which kind of work.
export const RoutingDecisionEvent = z.object({
  ts: z.string(),
  type: z.literal("routing-decision"),
  shape: z.enum(["one-shot", "spec-first", "decompose+verify"]),
  kind: z.enum(["feature", "bug", "refactor", "perf", "dep-upgrade", "ci-red"]),
});

// A gate reached/resolved (spec/plan/ship).
export const GateEvent = z.object({
  ts: z.string(),
  type: z.literal("gate"),
  gate: z.enum(["spec", "plan", "ship"]),
  outcome: z.enum(["reached", "approved", "changes"]),
});

// A node (dispatched unit of work) being entered. `agent` is the dispatched agent type when known.
export const NodeEnterEvent = z.object({
  ts: z.string(),
  type: z.literal("node-enter"),
  node: z.string(),
  agent: z.string().optional(),
});

// A node returning — carries `durationMs` (the "spent N", doc 10 §5; AC8's required duration).
export const NodeDoneEvent = z.object({
  ts: z.string(),
  type: z.literal("node-done"),
  node: z.string(),
  durationMs: z.number(),
});

// The closed FLOW event union, discriminated on `.type`. A line whose `type` is outside this set
// fails to parse — the closed vocabulary that can't drift.
export const FlowEvent = z.discriminatedUnion("type", [
  RoutingDecisionEvent,
  GateEvent,
  NodeEnterEvent,
  NodeDoneEvent,
]);
export type FlowEvent = z.infer<typeof FlowEvent>;

// ---- Legacy backstop lines: the loose hook shape, kept parseable in the same stream (ADR-002) ----

// A `subagent-emit` hook line: `kind` (no `type`), with the optional correlation fields. Tagged
// `source: "hook"` by the reconciler so it is distinguishable from a FLOW line in the parsed view.
export const HookBackstopLine = z.object({
  ts: z.string(),
  kind: z.string(),
  agent: z.string().optional(),
  agentId: z.string().optional(),
  session: z.string().optional(),
});
export type HookBackstopLine = z.infer<typeof HookBackstopLine>;

// The discriminator result. A FLOW line carries `type`; a backstop line carries `kind` (no `type`);
// anything else — including an empty-/absent-`agent` main-session hook line (ADR-002 filter rule:
// the conductor itself starting a subagent reports no `agent`, so it is noise, not a node) — is a
// skip.
export type ParsedLogLine =
  | { kind: "flow"; event: FlowEvent }
  | { kind: "hook"; line: HookBackstopLine }
  | { kind: "skip" };

// Classify one raw `events.jsonl` line. A line with `type` is parsed as a FLOW event; a line with
// `kind` (and no `type`) is parsed as a backstop line — UNLESS its `agent` is empty/absent, in which
// case it is a main-session line and is skipped (ADR-002 filter rule). Unparseable/blank → skip
// (a malformed line never throws; the reader tolerates both shapes forever per ADR-002).
export function parseLogLine(line: string): ParsedLogLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "skip" };

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { kind: "skip" };
  }
  if (typeof raw !== "object" || raw === null) return { kind: "skip" };

  const obj = raw as Record<string, unknown>;

  // A `type` present ⇒ FLOW line. Validate against the closed union; a bad FLOW line is a skip, not
  // a throw (the stream stays readable past one corrupt entry).
  if ("type" in obj) {
    const parsed = FlowEvent.safeParse(obj);
    return parsed.success ? { kind: "flow", event: parsed.data } : { kind: "skip" };
  }

  // Otherwise a legacy hook line. The empty-/absent-`agent` main-session line is dropped (filter rule).
  if ("kind" in obj) {
    const agent = obj.agent;
    if (typeof agent !== "string" || agent.length === 0) return { kind: "skip" };
    const parsed = HookBackstopLine.safeParse(obj);
    return parsed.success ? { kind: "hook", line: parsed.data } : { kind: "skip" };
  }

  return { kind: "skip" };
}
