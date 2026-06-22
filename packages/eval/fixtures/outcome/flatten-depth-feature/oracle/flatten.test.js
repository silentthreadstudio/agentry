// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It requires the agent's BUILT
// src/flatten.js and asserts the depth-aware flatten contract: the default-deep happy path AND the finite-depth
// TRAP (an implementation that ignores `depth` and always fully flattens fails the finite-depth cases).

const test = require("node:test");
const assert = require("node:assert/strict");

const { flatten } = require("../src/flatten.js");

// --- happy path: default flattens completely ---
test("a flat array is unchanged", () => {
  assert.deepEqual(flatten([1, 2, 3]), [1, 2, 3]);
});

test("default depth flattens all the way down", () => {
  assert.deepEqual(flatten([1, [2, [3, [4]]]]), [1, 2, 3, 4]);
});

test("default depth flattens deeply nested mixed structures", () => {
  assert.deepEqual(flatten([[1], [2, [3, [4, [5]]]], 6]), [1, 2, 3, 4, 5, 6]);
});

// --- TRAP: respect a FINITE depth (an always-fully-deep impl that ignores `depth` fails these) ---
test("depth 1 flattens exactly one level, leaving deeper nesting intact", () => {
  assert.deepEqual(flatten([1, [2, [3, [4]]]], 1), [1, 2, [3, [4]]]);
});

test("depth 2 flattens exactly two levels", () => {
  assert.deepEqual(flatten([1, [2, [3, [4]]]], 2), [1, 2, 3, [4]]);
});

test("depth 0 does not flatten at all", () => {
  assert.deepEqual(flatten([1, [2, [3]]], 0), [1, [2, [3]]]);
});

// --- TRAP (other direction): a hardcoded one-level flatten would fail this default-deep case, already covered
// above; this guards the boundary where finite depth exceeds the actual nesting (no over- or under-flattening). ---
test("a finite depth larger than the nesting fully flattens without error", () => {
  assert.deepEqual(flatten([1, [2, [3]]], 5), [1, 2, 3]);
});
