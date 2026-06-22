// HIDDEN held-out oracle — encodes the SPEC'd staleness resolution: cache within the TTL window, recompute after.
// A counting `fetch` + a controllable `now()` make it deterministic. The uncached seed FAILS (fetches every time);
// golden PASSES; the cache-forever broken FAILS the post-expiry recompute assertion.
const test = require("node:test");
const assert = require("node:assert/strict");

const { getRate } = require("../src/rates.js");

// A fresh harness per test: a counting fetch and a movable clock. Each test uses a distinct `code` so module-level
// caches in the implementation do not bleed across tests.
function harness(code) {
  let clock = 1000;
  let calls = 0;
  const opts = {
    ttlMs: 100,
    now: () => clock,
    fetch: (c) => {
      calls += 1;
      return `${c}:${calls}`;
    },
  };
  return {
    get: () => getRate(code, opts),
    advance: (ms) => {
      clock += ms;
    },
    calls: () => calls,
  };
}

test("a second call within the TTL window is served from cache (no extra fetch)", () => {
  const h = harness("AAA");
  const first = h.get();
  const second = h.get();
  assert.equal(second, first);
  assert.equal(h.calls(), 1, "fetch should be called once within the window");
});

test("after the TTL expires, the value is recomputed (a fresh fetch)", () => {
  const h = harness("BBB");
  h.get();
  h.advance(150); // past ttlMs=100
  h.get();
  assert.equal(h.calls(), 2, "fetch should be called again once the entry is stale");
});

test("a value just before expiry is still cached", () => {
  const h = harness("CCC");
  h.get();
  h.advance(50); // still within ttlMs=100
  h.get();
  assert.equal(h.calls(), 1);
});

test("distinct codes are cached independently", () => {
  let clock = 0;
  let calls = 0;
  const opts = { ttlMs: 100, now: () => clock, fetch: () => (calls += 1) };
  getRate("X", opts);
  getRate("Y", opts);
  assert.equal(calls, 2, "two distinct codes => two fetches");
});
