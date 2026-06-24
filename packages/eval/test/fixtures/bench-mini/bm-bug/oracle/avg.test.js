// HIDDEN held-out oracle — the subtle-bug probe: asserts the empty-array case returns 0 (the bug yields NaN).
const test = require("node:test");
const assert = require("node:assert/strict");

const avg = require("../src/avg.js");

test("averages a non-empty array", () => {
  assert.equal(avg.average([2, 4, 6]), 4);
});

test("the EMPTY array returns 0, not NaN (the subtle-bug probe)", () => {
  assert.equal(avg.average([]), 0);
});
