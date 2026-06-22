// HIDDEN held-out oracle — the agent NEVER sees this. It requires the agent's BUILT src/duration.js and asserts
// every unit converts correctly. The un-fixed seed FAILs the hours assertion; a correct fix PASSES all.

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseDuration } = require("../src/duration.js");

test("seconds convert one-to-one", () => {
  assert.equal(parseDuration("90s"), 90);
});

test("minutes convert to seconds", () => {
  assert.equal(parseDuration("5m"), 300);
});

test("hours convert to seconds (the fixed bug)", () => {
  assert.equal(parseDuration("2h"), 7200);
});

test("one hour is 3600 seconds", () => {
  assert.equal(parseDuration("1h"), 3600);
});

test("zero is zero regardless of unit", () => {
  assert.equal(parseDuration("0h"), 0);
});
