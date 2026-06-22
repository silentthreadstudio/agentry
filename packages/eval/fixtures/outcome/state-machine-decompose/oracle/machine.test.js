// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It drives the BUILT machine
// through src/machine.js (which must coordinate src/states.js + src/transitions.js) and asserts the FSM contract:
// the valid happy path AND the invalid-transition-rejected, unknown-event, and final-state TRAP cases that only a
// per-state-guarded machine satisfies.

const test = require("node:test");
const assert = require("node:assert/strict");

const { create } = require("../src/machine.js");

// --- happy path: the valid linear workflow advances correctly ---
test("advances through the valid linear path", () => {
  const m = create("draft");
  assert.equal(m.send("submit"), true);
  assert.equal(m.state, "review");
  assert.equal(m.send("approve"), true);
  assert.equal(m.state, "published");
  assert.equal(m.send("archive"), true);
  assert.equal(m.state, "archived");
});

test("review can be rejected back to draft", () => {
  const m = create("draft");
  m.send("submit");
  assert.equal(m.send("reject"), true);
  assert.equal(m.state, "draft");
});

// --- TRAP: an event invalid from the current state is rejected; the machine stays put ---
test("rejects an event not allowed from the current state and stays put", () => {
  const m = create("draft");
  // "approve" is only valid from "review" -> from "draft" it must be rejected, NOT applied.
  assert.equal(m.send("approve"), false);
  assert.equal(m.state, "draft");
});

test("rejects an unknown event and stays put", () => {
  const m = create("draft");
  assert.equal(m.send("frobnicate"), false);
  assert.equal(m.state, "draft");
});

// --- TRAP: a final state accepts no further events ---
test("a final state rejects every event and stays final", () => {
  const m = create("draft");
  m.send("submit");
  m.send("approve");
  m.send("archive"); // -> archived (final)
  assert.equal(m.state, "archived");
  assert.equal(m.send("submit"), false);
  assert.equal(m.send("approve"), false);
  assert.equal(m.state, "archived");
});

// --- create rejects an invalid initial state ---
test("create throws on an invalid initial state", () => {
  assert.throws(() => create("nonsense"));
});
