// comment-routing — the pure session-targeting decision. Every branch of shouldRouteToThisSession,
// with sessionsBoundTo injected so there's no fs (the bug: without this gate every process emits
// every run's comments — these prove the four-way decision that stops the broadcast).
import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRouteToThisSession } from "../src/resolution/comment-routing.js";

test("owned via myRuns → route (this process operated on the run)", () => {
  const decision = shouldRouteToThisSession("run-a", {
    myRuns: new Set(["run-a"]),
    mySessionId: undefined,
    sessionsBoundTo: () => [],
  });
  assert.equal(decision, true);
});

test("owned via the persisted pointer → route (bound to this session)", () => {
  const decision = shouldRouteToThisSession("run-a", {
    myRuns: new Set(),
    mySessionId: "sess-1",
    sessionsBoundTo: () => ["sess-1"],
  });
  assert.equal(decision, true);
});

test("claimed by ANOTHER session → drop (not ours)", () => {
  const decision = shouldRouteToThisSession("run-a", {
    myRuns: new Set(),
    mySessionId: "sess-1",
    sessionsBoundTo: () => ["sess-other"],
  });
  assert.equal(decision, false);
});

test("claimed by another session, no session id on this process → drop", () => {
  const decision = shouldRouteToThisSession("run-a", {
    myRuns: new Set(),
    mySessionId: undefined,
    sessionsBoundTo: () => ["sess-other"],
  });
  assert.equal(decision, false);
});

test("orphan (no live match, no persisted owner) → broadcast so the comment is never lost", () => {
  const decision = shouldRouteToThisSession("run-a", {
    myRuns: new Set(),
    mySessionId: "sess-1",
    sessionsBoundTo: () => [],
  });
  assert.equal(decision, true);
});

test("myRuns wins even when another session also claims the run", () => {
  // A run operated on directly is ours regardless of who else's pointer claims it — myRuns is checked
  // first, so the owner short-circuits before the owners-includes-other drop.
  const decision = shouldRouteToThisSession("run-a", {
    myRuns: new Set(["run-a"]),
    mySessionId: "sess-1",
    sessionsBoundTo: () => ["sess-other"],
  });
  assert.equal(decision, true);
});
