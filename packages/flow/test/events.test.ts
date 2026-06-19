// parseLogLine — the typed-vs-legacy discriminator (ADR-002): a FLOW line classifies as `flow`, a
// legacy hook line with a real `agent` as `hook`, and an empty-`agent` main-session line as `skip`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowEvent, RoutingDecisionEvent, parseLogLine } from "../src/domain/events.js";

test("parseLogLine classifies a FLOW line (has .type) as flow", () => {
  const line = JSON.stringify({
    ts: "2026-06-19T10:00:00.000Z",
    type: "node-done",
    node: "implement-T01",
    durationMs: 1234,
  });
  const parsed = parseLogLine(line);
  assert.equal(parsed.kind, "flow");
  if (parsed.kind === "flow") assert.equal(parsed.event.type, "node-done");
});

test("parseLogLine classifies a legacy hook line (has .kind, real agent) as hook", () => {
  const line = JSON.stringify({
    ts: "2026-06-19T10:00:00.000Z",
    kind: "agent-started",
    agent: "agentry:architect",
    agentId: "abc",
    session: "sess-1",
  });
  const parsed = parseLogLine(line);
  assert.equal(parsed.kind, "hook");
  if (parsed.kind === "hook") assert.equal(parsed.line.agent, "agentry:architect");
});

test("parseLogLine skips an empty-agent main-session hook line (ADR-002 filter rule)", () => {
  const absent = JSON.stringify({ ts: "t", kind: "agent-started", agentId: "x" });
  const empty = JSON.stringify({ ts: "t", kind: "agent-started", agent: "" });
  assert.equal(parseLogLine(absent).kind, "skip");
  assert.equal(parseLogLine(empty).kind, "skip");
});

test("parseLogLine skips blank and unparseable lines without throwing", () => {
  assert.equal(parseLogLine("").kind, "skip");
  assert.equal(parseLogLine("   ").kind, "skip");
  assert.equal(parseLogLine("{not json").kind, "skip");
  assert.equal(parseLogLine("42").kind, "skip");
});

test("parseLogLine skips a malformed FLOW line (type present, payload invalid)", () => {
  // type is a known literal but the required payload (durationMs) is missing → not a valid FlowEvent.
  const line = JSON.stringify({ ts: "t", type: "node-done", node: "x" });
  assert.equal(parseLogLine(line).kind, "skip");
});

test("FlowEvent rejects a type outside the closed union", () => {
  assert.equal(FlowEvent.safeParse({ ts: "t", type: "made-up", x: 1 }).success, false);
});

// Regression: the conductor/core canonical shape is "decompose+verify" (core KnownShape, and the
// conducting skill emits it). RoutingDecisionEvent must ACCEPT it — when the enum carried the bare
// "decompose" instead, the conductor's routing-decision event was silently rejected on every
// decompose run (found by live T08 validation, not the unit suite, because the units used FLOW's
// OWN value). This guards the conductor↔FLOW vocabulary seam.
test("RoutingDecisionEvent accepts the canonical decompose+verify shape", () => {
  const event = { ts: "2026-06-19T10:00:00.000Z", type: "routing-decision", shape: "decompose+verify", kind: "feature" };
  assert.equal(RoutingDecisionEvent.safeParse(event).success, true);
});

test("FlowEvent classifies a routing-decision with decompose+verify as flow", () => {
  const line = JSON.stringify({ ts: "2026-06-19T10:00:00.000Z", type: "routing-decision", shape: "decompose+verify", kind: "feature" });
  const parsed = parseLogLine(line);
  assert.equal(parsed.kind, "flow");
  if (parsed.kind === "flow") assert.equal(parsed.event.type, "routing-decision");
});
