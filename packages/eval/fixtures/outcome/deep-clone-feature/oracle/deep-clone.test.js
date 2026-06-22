// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It requires the agent's BUILT
// src/deep-clone.js and asserts the deep-copy contract: the value-equality happy path AND the deep-isolation TRAP
// (a shallow copy shares nested references, so mutating the clone at depth would corrupt the original).

const test = require("node:test");
const assert = require("node:assert/strict");

const { deepClone } = require("../src/deep-clone.js");

// --- happy path: value equality ---
test("clones a flat object by value", () => {
  const o = { a: 1, b: "x" };
  assert.deepEqual(deepClone(o), { a: 1, b: "x" });
});

test("clones primitives as-is", () => {
  assert.equal(deepClone(42), 42);
  assert.equal(deepClone("hi"), "hi");
  assert.equal(deepClone(null), null);
});

test("clones a nested object/array structure by value", () => {
  const o = { a: { b: 1 }, list: [1, [2, 3]] };
  assert.deepEqual(deepClone(o), { a: { b: 1 }, list: [1, [2, 3]] });
});

// --- TRAP: deep isolation. A shallow copy ({...obj}) shares the nested references, so mutating the clone at
// depth mutates the original. The top-level keys ARE independent under a shallow copy, so we must probe at depth.
test("mutating a nested object on the clone does NOT touch the original (defeats shallow copy)", () => {
  const o = { a: { b: 1 } };
  const c = deepClone(o);
  c.a.b = 99;
  assert.equal(o.a.b, 1, "nested object was shared — this is a shallow copy");
});

test("mutating a nested array on the clone does NOT touch the original", () => {
  const o = { list: [1, [2]] };
  const c = deepClone(o);
  c.list[1].push(3);
  assert.deepEqual(o.list[1], [2], "nested array was shared — this is a shallow copy");
});

test("the nested objects are different references from the original", () => {
  const o = { a: { b: 1 } };
  const c = deepClone(o);
  assert.notEqual(c.a, o.a, "clone.a is the same reference as original.a — shallow copy");
});

test("top-level reassignment on the clone leaves the original intact", () => {
  const o = { a: 1 };
  const c = deepClone(o);
  c.a = 2;
  assert.equal(o.a, 1);
});
