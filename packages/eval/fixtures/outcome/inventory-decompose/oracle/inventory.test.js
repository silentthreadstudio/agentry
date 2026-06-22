// HIDDEN held-out oracle — the agent NEVER sees this. It drives the public API from src/index.js end to end, so
// all THREE parts (store, report, barrel) must coordinate for the suite to pass.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createStore, lowStock } = require("../src/index.js");

test("add accumulates a running total per sku", () => {
  const s = createStore();
  s.add("a", 3);
  s.add("a", 2);
  assert.equal(s.quantity("a"), 5);
});

test("an unknown sku reads as zero", () => {
  const s = createStore();
  assert.equal(s.quantity("nope"), 0);
});

test("remove subtracts but never goes below zero", () => {
  const s = createStore();
  s.add("a", 2);
  s.remove("a", 5);
  assert.equal(s.quantity("a"), 0);
});

test("skus lists every sku ever added", () => {
  const s = createStore();
  s.add("b", 1);
  s.add("a", 1);
  assert.deepEqual([...s.skus()].sort(), ["a", "b"]);
});

test("lowStock reports skus strictly below the threshold, sorted ascending", () => {
  const s = createStore();
  s.add("c", 1);
  s.add("a", 5);
  s.add("b", 2);
  assert.deepEqual(lowStock(s, 3), ["b", "c"]);
});

test("lowStock excludes a sku exactly at the threshold (strictly below)", () => {
  const s = createStore();
  s.add("a", 3);
  s.add("b", 2);
  assert.deepEqual(lowStock(s, 3), ["b"]);
});
