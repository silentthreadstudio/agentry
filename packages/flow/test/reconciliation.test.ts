// Backstop reconciliation (AC9, ADR-003) — the read-time cross-check that makes a SKIPPED FLOW call
// detectable. Given hook backstop lines (agent-started/agent-done, the legacy `subagent-emit` shape)
// and FLOW node lines in the SAME events.jsonl, run_status surfaces a disagreement when a hook
// subagent boundary has no matching FLOW node-enter/node-done. A consistent stream → empty. It is a
// pure read-time computation: nothing is written and nothing blocks (the hook always exits 0).
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createServices } from "../src/index.js";
import { RunService } from "../src/application/run-service.js";

let cwd: string;
let service: RunService;
let run: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "flow-reconcile-"));
  service = new RunService(createServices(cwd));
  ({ run } = service.start({ goal: "reconcile run" }));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// Append a raw line straight to the stream (the hook does this dep-free; FLOW emits via `service.emit`).
function appendRaw(line: object): void {
  appendFileSync(join(cwd, ".agentry", "work", run, "events.jsonl"), `${JSON.stringify(line)}\n`);
}

test("AC9: a hook start/stop with NO matching FLOW node surfaces as a disagreement", () => {
  // The hook recorded a subagent boundary the conductor SKIPPED the FLOW node calls for.
  appendRaw({ ts: "2026-01-01T00:00:00.000Z", kind: "agent-started", agent: "agentry:verifier", agentId: "v1" });
  appendRaw({ ts: "2026-01-01T00:01:00.000Z", kind: "agent-done", agent: "agentry:verifier", agentId: "v1" });

  const { backstopDisagreements } = service.status(run);
  assert.ok(backstopDisagreements.length > 0, "the skipped FLOW call is flagged");
  const agents = backstopDisagreements.map((d) => d.agent);
  assert.ok(agents.includes("agentry:verifier"), "the unmatched agent is named");
});

test("AC9: a consistent stream (FLOW node lines matching the hook boundary) → no disagreement", () => {
  // FLOW emitted the node lines the hook boundary corresponds to (matched on `agent`).
  service.emit(run, { ts: "2026-01-01T00:00:01.000Z", type: "node-enter", node: "N1", agent: "agentry:implementer" });
  service.emit(run, { ts: "2026-01-01T00:01:01.000Z", type: "node-done", node: "N1", durationMs: 1000 });
  appendRaw({ ts: "2026-01-01T00:00:00.000Z", kind: "agent-started", agent: "agentry:implementer", agentId: "i1" });
  appendRaw({ ts: "2026-01-01T00:01:00.000Z", kind: "agent-done", agent: "agentry:implementer", agentId: "i1" });

  const { backstopDisagreements } = service.status(run);
  assert.deepEqual(backstopDisagreements, [], "agreeing records produce no disagreement");
});

test("the empty-agent main-session hook line is NOT a disagreement (filtered, ADR-002)", () => {
  // The conductor itself starting a subagent reports no `agent` — noise, not a node boundary.
  appendRaw({ ts: "2026-01-01T00:00:00.000Z", kind: "agent-started", agent: "" });
  appendRaw({ ts: "2026-01-01T00:00:01.000Z", kind: "agent-started" }); // absent agent

  const { backstopDisagreements } = service.status(run);
  assert.deepEqual(backstopDisagreements, [], "main-session lines are filtered, never flagged");
});

test("a node-enter with no node-done but a hook agent-done flags the done side", () => {
  // FLOW entered the node but never emitted node-done; the hook saw the subagent finish → done-side gap.
  service.emit(run, { ts: "2026-01-01T00:00:01.000Z", type: "node-enter", node: "N2", agent: "agentry:designer" });
  appendRaw({ ts: "2026-01-01T00:00:00.000Z", kind: "agent-started", agent: "agentry:designer", agentId: "d1" });
  appendRaw({ ts: "2026-01-01T00:01:00.000Z", kind: "agent-done", agent: "agentry:designer", agentId: "d1" });

  const { backstopDisagreements } = service.status(run);
  assert.equal(backstopDisagreements.length, 1, "only the done side disagrees (the start matched)");
  assert.equal(backstopDisagreements[0].kind, "done");
  assert.equal(backstopDisagreements[0].agent, "agentry:designer");
});
