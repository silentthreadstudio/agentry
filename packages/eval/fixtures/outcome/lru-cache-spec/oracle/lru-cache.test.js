// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It requires the agent's BUILT
// src/lru-cache.js and asserts the LRU contract: basic store/get (happy path) AND the refresh-on-get, FIFO-vs-LRU,
// update-does-not-grow, and capacity-eviction TRAP cases that only a true recency-aware cache satisfies.

const test = require("node:test");
const assert = require("node:assert/strict");

const { LRUCache } = require("../src/lru-cache.js");

// --- happy path: store and read under capacity ---
test("stores and reads values under capacity", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("b"), 2);
});

test("returns undefined for an absent key", () => {
  const c = new LRUCache(2);
  assert.equal(c.get("missing"), undefined);
});

// --- TRAP: at capacity, the least-recently-used (oldest untouched) key is evicted ---
test("evicts the least-recently-used key when capacity is exceeded", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3); // exceeds capacity 2 -> "a" (LRU) is evicted
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("b"), 2);
  assert.equal(c.get("c"), 3);
});

// --- TRAP: a get refreshes recency, so a FIFO cache evicts the wrong key here ---
test("a get refreshes recency and rescues a key from eviction", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a"); // touch "a" -> now "b" is the least-recently-used
  c.set("c", 3); // exceeds capacity -> "b" must be evicted, NOT "a"
  assert.equal(c.get("a"), 1); // FIFO would have wrongly evicted "a"
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("c"), 3);
});

// --- TRAP: updating an existing key does not grow the size (no eviction triggered) ---
test("updating an existing key overwrites in place without growing size", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 99); // update, not a new entry -> size stays 2, nothing evicted
  assert.equal(c.get("a"), 99);
  assert.equal(c.get("b"), 2);
});

// --- TRAP: a set also refreshes recency ---
test("a set on an existing key refreshes its recency", () => {
  const c = new LRUCache(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 11); // touch "a" via set -> "b" is now LRU
  c.set("c", 3); // exceeds capacity -> "b" evicted, "a" survives
  assert.equal(c.get("a"), 11);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("c"), 3);
});
