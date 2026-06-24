// HIDDEN held-out oracle — the recency probe is the discriminator: read key "a", then insert past capacity, and a
// true LRU evicts "b" (the now-least-recently-used) while the FIFO broken build wrongly evicts the just-read "a".
const test = require("node:test");
const assert = require("node:assert/strict");

const { createLRU } = require("../src/index.js");
const { lruVictim } = require("../src/policy.js");

test("stores and returns values up to capacity", () => {
  const c = createLRU(2);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("b"), 2);
  assert.equal(c.size(), 2);
});

test("evicts the least-recently-INSERTED when nothing has been read", () => {
  const c = createLRU(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3); // exceeds capacity → evict the front ("a")
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("c"), 3);
  assert.equal(c.size(), 2);
});

test("the recency probe: a READ refreshes recency, so the just-read key survives eviction", () => {
  const c = createLRU(2);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a"); // "a" is now most-recently-used; "b" is least
  c.set("c", 3); // must evict "b", NOT the just-read "a"
  assert.equal(c.get("a"), 1, "the recently-read key must survive (true LRU, not FIFO)");
  assert.equal(c.get("b"), undefined, "the least-recently-used key is evicted");
  assert.equal(c.get("c"), 3);
});

test("updating an existing key does not grow the cache or evict", () => {
  const c = createLRU(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 9); // update in place
  assert.equal(c.size(), 2);
  assert.equal(c.get("a"), 9);
  assert.equal(c.get("b"), 2);
});

test("lruVictim is pure and returns the front of the recency order", () => {
  assert.equal(lruVictim(["x", "y", "z"]), "x");
});
