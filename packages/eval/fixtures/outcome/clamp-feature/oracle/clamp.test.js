// HIDDEN held-out oracle — the agent NEVER sees this (it lives in oracle/, injected post-run by the harness).
// It requires the agent's BUILT src/clamp.js (one dir up from the injected oracle/) and asserts the clamp
// contract objectively. node:test prints the `# pass / # fail / # tests` TAP summary the oracle parser reads.

const test = require("node:test");
const assert = require("node:assert/strict");

const { clamp } = require("../src/clamp.js");

test("returns n unchanged when inside the range", () => {
  assert.equal(clamp(5, 0, 10), 5);
});

test("returns lo when n is below the range", () => {
  assert.equal(clamp(-3, 0, 10), 0);
});

test("returns hi when n is above the range", () => {
  assert.equal(clamp(42, 0, 10), 10);
});

test("bounds are inclusive at the low edge", () => {
  assert.equal(clamp(0, 0, 10), 0);
});

test("bounds are inclusive at the high edge", () => {
  assert.equal(clamp(10, 0, 10), 10);
});

test("works with negative ranges", () => {
  assert.equal(clamp(-5, -10, -1), -5);
  assert.equal(clamp(0, -10, -1), -1);
});
