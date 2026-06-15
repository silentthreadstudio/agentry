import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkEvent } from "../src/events.js";

test("WorkEvent.parse accepts a line with the additive fields and preserves them", () => {
  const line = {
    ts: "2026-06-14T00:00:00.000Z",
    kind: "agent-started",
    agent: "architect",
    agentId: "ag_abc123",
    session: "sess_xyz",
  };
  const parsed = WorkEvent.parse(line);
  assert.equal(parsed.agentId, "ag_abc123");
  assert.equal(parsed.session, "sess_xyz");
});

test("WorkEvent.parse still accepts a legacy line with neither additive field (back-compat)", () => {
  const line = { ts: "2026-06-14T00:00:00.000Z", kind: "agent-done" };
  assert.deepEqual(WorkEvent.parse(line), line);
});

test("WorkEvent.parse rejects an empty object — ts/kind remain required", () => {
  assert.throws(() => WorkEvent.parse({}));
});
