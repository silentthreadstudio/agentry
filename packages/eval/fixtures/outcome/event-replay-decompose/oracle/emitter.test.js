// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It requires the agent's BUILT
// src/emitter.js and asserts the emitter contract: live delivery (happy path) AND the replay / de-dup / unsub
// TRAP cases that only a buffered, coordinated emitter satisfies.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createEmitter } = require("../src/emitter.js");

// --- happy path: a subscriber present at emit time receives live events ---
test("delivers live events to a current subscriber", () => {
  const em = createEmitter();
  const got = [];
  em.subscribe((e) => got.push(e.id));
  em.emit({ id: "a" });
  em.emit({ id: "b" });
  assert.deepEqual(got, ["a", "b"]);
});

// --- TRAP: a late subscriber replays the buffer in order, then gets live events ---
test("a late subscriber replays buffered events in order, then receives live events", () => {
  const em = createEmitter();
  em.emit({ id: "a" });
  em.emit({ id: "b" });
  const got = [];
  em.subscribe((e) => got.push(e.id)); // joins AFTER a,b were emitted
  em.emit({ id: "c" });
  assert.deepEqual(got, ["a", "b", "c"]);
});

// --- TRAP: an event whose id was already emitted is never delivered twice ---
test("a duplicate id is ignored (no double delivery)", () => {
  const em = createEmitter();
  const got = [];
  em.subscribe((e) => got.push(e.id));
  em.emit({ id: "a" });
  em.emit({ id: "a" }); // duplicate id — must be ignored
  em.emit({ id: "b" });
  assert.deepEqual(got, ["a", "b"]);
});

test("a duplicate of a buffered event is not replayed to a late subscriber", () => {
  const em = createEmitter();
  em.emit({ id: "a" });
  em.emit({ id: "a" }); // duplicate before anyone subscribes
  const got = [];
  em.subscribe((e) => got.push(e.id));
  assert.deepEqual(got, ["a"]);
});

// --- TRAP: unsubscribe stops further delivery ---
test("unsubscribe stops all further delivery to that handler", () => {
  const em = createEmitter();
  const got = [];
  const unsubscribe = em.subscribe((e) => got.push(e.id));
  em.emit({ id: "a" });
  unsubscribe();
  em.emit({ id: "b" }); // must not reach the unsubscribed handler
  assert.deepEqual(got, ["a"]);
});
