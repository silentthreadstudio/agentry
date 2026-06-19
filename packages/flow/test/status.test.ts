// FlowTaskStatus / AgentState — the closed enums reject out-of-set values (pre-proof for AC2: an
// invalid status can never reach a file because it fails to parse).
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentState, FlowTaskStatus } from "../src/domain/status.js";

test("FlowTaskStatus accepts every value in the closed set", () => {
  for (const v of ["todo", "in-progress", "in-review", "done"]) {
    assert.equal(FlowTaskStatus.parse(v), v);
  }
});

test("FlowTaskStatus rejects a value outside the closed enum", () => {
  assert.equal(FlowTaskStatus.safeParse("ready").success, false); // legacy vocabulary, now out
  assert.equal(FlowTaskStatus.safeParse("sliced").success, false);
  assert.equal(FlowTaskStatus.safeParse("").success, false);
});

test("AgentState rejects a value outside the closed enum", () => {
  for (const v of ["working", "blocked", "done"]) assert.equal(AgentState.parse(v), v);
  assert.equal(AgentState.safeParse("idle").success, false);
});
