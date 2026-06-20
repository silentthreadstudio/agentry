// Tests for the live-agent-overlay fold (use-roster): roster + events → the node map + panel rows, and the
// compact elapsed formatter. Pure functions (no fetch, no React) — the timer/ws plumbing isn't exercised
// here, only the data shaping the canvas + roster panel render from.
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentView, EventView } from "@agentry/workbench-shared";
import { fold, formatElapsed } from "../routes/work/live/use-roster.js";

function ev(node: string, agent: string, ts: string): EventView {
  return { id: `${node}-${ts}`, event: { type: "node-enter", node, agent, ts } };
}

test("byNode is built from WORKING agents (roster-authoritative), keyed by the task's node id", () => {
  const agents: AgentView[] = [
    { id: "r:implementer", role: "implementer", state: "working", task: "003" }, // bare number → task-003
    { id: "r:verifier", role: "verifier", state: "blocked", task: "005" }, // not working → not in byNode
  ];
  const events: EventView[] = [ev("task-003", "implementer", "2026-06-20T10:05:00.000Z")];
  const { byNode } = fold(agents, events);
  assert.equal(byNode.size, 1, "only the working agent lands a node chip");
  assert.equal(byNode.get("task-003")?.role, "implementer");
  assert.equal(byNode.get("task-003")?.sinceIso, "2026-06-20T10:05:00.000Z", "timer base from node-enter");
  assert.equal(byNode.has("task-005"), false, "a blocked agent is not on a node chip");
});

test("a working agent with no matching node-enter still gets a chip, just no timer", () => {
  const agents: AgentView[] = [{ id: "r:i", role: "implementer", state: "working", task: "003" }];
  // hook-backstop node-enter (node = a hook kind, not a graph node id) → no match → empty since
  const events: EventView[] = [ev("agent-started", "implementer", "2026-06-20T10:00:00.000Z")];
  const { byNode } = fold(agents, events);
  assert.equal(byNode.get("task-003")?.role, "implementer");
  assert.equal(byNode.get("task-003")?.sinceIso, "", "no matching node-enter → no timer, chip still shows");
});

test("panel rows carry every agent with best-effort sinceIso", () => {
  const agents: AgentView[] = [
    { id: "r:i", role: "implementer", state: "working", task: "003" },
    { id: "r:v", role: "verifier", state: "blocked", task: null },
  ];
  const events: EventView[] = [ev("task-003", "implementer", "2026-06-20T10:00:00.000Z")];
  const { agents: rows } = fold(agents, events);
  assert.equal(rows.find((r) => r.role === "implementer")?.sinceIso, "2026-06-20T10:00:00.000Z");
  const ver = rows.find((r) => r.role === "verifier");
  assert.equal(ver?.sinceIso, null, "an agent with no task has no since");
  assert.equal(ver?.state, "blocked");
});

test("formatElapsed renders compact s / m / h m", () => {
  const base = Date.parse("2026-06-20T10:00:00.000Z");
  assert.equal(formatElapsed("2026-06-20T10:00:00.000Z", base + 45_000), "45s");
  assert.equal(formatElapsed("2026-06-20T10:00:00.000Z", base + 2 * 60_000 + 14_000), "2m");
  assert.equal(formatElapsed("2026-06-20T10:00:00.000Z", base + (60 + 4) * 60_000), "1h 4m");
  assert.equal(formatElapsed("not-a-date", base), "");
});
