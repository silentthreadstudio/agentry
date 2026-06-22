// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It drives time with a FAKE
// CLOCK: before requiring the agent's BUILT src/debounce.js it replaces the global setTimeout/clearTimeout with a
// deterministic queue, so no real timers are used and the test is fully deterministic. It asserts the trailing-
// debounce contract: exactly ONE invocation, after the delay, with the LAST arguments — the leading-edge / fire-
// every-call TRAP fails here.

const test = require("node:test");
const assert = require("node:assert/strict");

// --- fake clock: install BEFORE requiring the module so debounce captures these globals ---
let timers = [];
let seq = 0;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;

global.setTimeout = (cb, delay) => {
  const id = ++seq;
  timers.push({ id, cb, delay });
  return id;
};
global.clearTimeout = (id) => {
  timers = timers.filter((t) => t.id !== id);
};

// Advance the fake clock by `ms`, firing any timers whose delay has elapsed (each fires once).
function advance(ms) {
  const due = [];
  for (const t of timers) {
    t.delay -= ms;
    if (t.delay <= 0) due.push(t);
  }
  timers = timers.filter((t) => t.delay > 0);
  for (const t of due) t.cb();
}

function reset() {
  timers = [];
  seq = 0;
}

const { debounce } = require("../src/debounce.js");

// Restore real timers when the suite finishes so we never leak the fake clock.
test.after(() => {
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
});

test("does NOT fire before the delay elapses", () => {
  reset();
  let calls = 0;
  const d = debounce(() => calls++, 100);
  d();
  advance(99);
  assert.equal(calls, 0, "fired before the delay — leading-edge or no timer reset");
});

test("fires once after the delay for a single call", () => {
  reset();
  let calls = 0;
  const d = debounce(() => calls++, 100);
  d();
  advance(100);
  assert.equal(calls, 1);
});

test("a burst of calls fires fn exactly ONCE (coalesced)", () => {
  reset();
  let calls = 0;
  const d = debounce(() => calls++, 100);
  d();
  advance(50);
  d();
  advance(50);
  d();
  advance(100);
  assert.equal(calls, 1, "fired more than once — not coalescing (fires every call?)");
});

test("does not fire mid-burst (each call resets the timer)", () => {
  reset();
  let calls = 0;
  const d = debounce(() => calls++, 100);
  d();
  advance(80);
  d(); // resets the 100ms window
  advance(80); // 160ms since first call, but only 80ms since the reset
  assert.equal(calls, 0, "fired mid-burst — the timer did not reset on the second call");
});

test("invokes fn with the LATEST arguments from the burst", () => {
  reset();
  const seen = [];
  const d = debounce((x) => seen.push(x), 100);
  d("first");
  advance(50);
  d("second");
  advance(50);
  d("third");
  advance(100);
  assert.deepEqual(seen, ["third"], "did not use the last call's arguments");
});

test("a fresh burst after a quiet period fires again", () => {
  reset();
  let calls = 0;
  const d = debounce(() => calls++, 100);
  d();
  advance(100);
  d();
  advance(100);
  assert.equal(calls, 2);
});
