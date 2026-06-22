// HIDDEN held-out oracle — drives the log, the reducer, and replay. The stub seed FAILS (throws); golden PASSES;
// the by-ignoring broken reducer FAILS the magnitude assertions.
const test = require("node:test");
const assert = require("node:assert/strict");

const { createLog } = require("../src/log.js");
const { apply } = require("../src/reducer.js");
const { replay } = require("../src/index.js");

test("replay folds a sequence of events with explicit and default `by`", () => {
  const log = createLog();
  log.append({ type: "inc", by: 3 });
  log.append({ type: "dec" });
  log.append({ type: "inc" });
  assert.equal(replay(log), 3); // 0 + 3 - 1 + 1
});

test("the reducer is pure and respects `by`", () => {
  assert.equal(apply(10, { type: "inc", by: 5 }), 15);
  assert.equal(apply(10, { type: "dec", by: 4 }), 6);
});

test("an unknown event type leaves state unchanged", () => {
  assert.equal(apply(7, { type: "noop" }), 7);
});

test("the log returns events in append order and is not the same array reference", () => {
  const log = createLog();
  log.append({ type: "inc" });
  const a = log.all();
  const b = log.all();
  assert.equal(a.length, 1);
  assert.notEqual(a, b);
});

test("replaying an empty log yields the initial state 0", () => {
  assert.equal(replay(createLog()), 0);
});
