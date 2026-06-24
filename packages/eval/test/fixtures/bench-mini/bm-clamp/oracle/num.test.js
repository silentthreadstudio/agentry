// HIDDEN held-out oracle — asserts the `clamp` contract AND that `toFixed2` still works.
const test = require("node:test");
const assert = require("node:assert/strict");

const num = require("../src/num.js");

test("in-range value is returned unchanged", () => {
  assert.equal(num.clamp(5, 0, 10), 5);
});

test("below the floor returns the floor", () => {
  assert.equal(num.clamp(-3, 0, 10), 0);
});

test("above the ceiling returns the ceiling", () => {
  assert.equal(num.clamp(99, 0, 10), 10);
});

test("the existing toFixed2 is untouched", () => {
  assert.equal(num.toFixed2(2.345), 2.35);
});
