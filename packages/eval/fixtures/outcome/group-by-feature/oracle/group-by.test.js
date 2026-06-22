// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It requires the agent's BUILT
// src/group-by.js and asserts the grouping contract: ordinary grouping + order, AND the prototype-collision TRAP
// (a key like "toString" must group correctly, which a plain `{}` accumulator with `acc[k] = acc[k] || []`
// breaks — `acc["toString"]` inherits Object.prototype.toString, a truthy function, so `.push` throws).

const test = require("node:test");
const assert = require("node:assert/strict");

const { groupBy } = require("../src/group-by.js");

// --- happy path ---
test("groups by a parity key", () => {
  const r = groupBy([1, 2, 3, 4], (n) => (n % 2 === 0 ? "even" : "odd"));
  assert.deepEqual(r.odd, [1, 3]);
  assert.deepEqual(r.even, [2, 4]);
});

test("preserves original order within each group", () => {
  const r = groupBy(["b1", "a1", "b2", "a2", "a3"], (s) => s[0]);
  assert.deepEqual(r.a, ["a1", "a2", "a3"]);
  assert.deepEqual(r.b, ["b1", "b2"]);
});

test("an empty input groups to an empty result", () => {
  assert.deepEqual(Object.keys(groupBy([], () => "x")), []);
});

// --- TRAP: a key colliding with a built-in member name must still group correctly ---
test("groups under a key named 'toString' without inheriting the prototype member", () => {
  const items = [{ t: "toString", v: 1 }, { t: "toString", v: 2 }, { t: "ok", v: 3 }];
  const r = groupBy(items, (o) => o.t);
  assert.deepEqual(r.toString, [{ t: "toString", v: 1 }, { t: "toString", v: 2 }]);
  assert.deepEqual(r.ok, [{ t: "ok", v: 3 }]);
});

test("groups under a key named 'constructor'", () => {
  const r = groupBy(["constructor", "constructor", "other"], (s) => s);
  assert.deepEqual(r.constructor, ["constructor", "constructor"]);
  assert.deepEqual(r.other, ["other"]);
});

test("a 'hasOwnProperty' key groups correctly", () => {
  const r = groupBy([1, 1, 2], (n) => (n === 1 ? "hasOwnProperty" : "two"));
  assert.deepEqual(r.hasOwnProperty, [1, 1]);
  assert.deepEqual(r.two, [2]);
});
