// status-event — the pure human→agent status-channel renderer. Verifies the signal shape parses and the
// channel notification carries the right content + snake_case meta (run_id/task/status/kind).
import assert from "node:assert/strict";
import { test } from "node:test";
import { StatusSignal, statusNotification } from "../src/channel/status-event.js";

test("statusNotification renders content + snake_case meta", () => {
  const n = statusNotification({ run: "build-x", task: "task-003", status: "done" });
  assert.match(n.content, /task-003/);
  assert.match(n.content, /done/);
  assert.equal(n.meta.run_id, "build-x");
  assert.equal(n.meta.task, "task-003");
  assert.equal(n.meta.status, "done");
  assert.equal(n.meta.kind, "status");
});

test("StatusSignal parses the pinned shape; rejects a non-object", () => {
  const ok = StatusSignal.safeParse({ run: "r", task: "task-1", status: "todo", at: "2026-06-20T00:00:00Z" });
  assert.equal(ok.success, true);
  assert.equal(StatusSignal.safeParse({ run: "r" }).success, false); // missing task/status
});
