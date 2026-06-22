// HIDDEN held-out oracle — the agent NEVER sees this. It requires the agent's BUILT src/brackets.js and asserts
// the balanced/unbalanced contract. The un-fixed seed FAILs the stray-closer cases; a correct fix PASSES all.

const test = require("node:test");
const assert = require("node:assert/strict");

const { isBalanced } = require("../src/brackets.js");

test("accepts correctly nested mixed brackets", () => {
  assert.equal(isBalanced("(a[b]{c})"), true);
});

test("accepts an empty string (vacuously balanced)", () => {
  assert.equal(isBalanced(""), true);
});

test("rejects an unclosed opener", () => {
  assert.equal(isBalanced("(a"), false);
});

test("rejects a stray closer (the fixed bug)", () => {
  assert.equal(isBalanced("a)"), false);
});

test("rejects an extra closer after a balanced run (the fixed bug)", () => {
  assert.equal(isBalanced("(a)b)"), false);
});

test("rejects a wrong-type closer", () => {
  assert.equal(isBalanced("(a]"), false);
});
