// HIDDEN held-out oracle — the agent NEVER sees this. It drives the public API from src/index.js. The un-fixed
// seed FAILs the partial-page cases (and the isLast that depends on them); a correct ceil fix PASSES all.

const test = require("node:test");
const assert = require("node:assert/strict");

const { pageCount, pageInfo } = require("../src/index.js");

test("an even division needs exactly that many pages", () => {
  assert.equal(pageCount(9, 3), 3);
});

test("a partial final page is counted (the fixed bug)", () => {
  assert.equal(pageCount(10, 3), 4);
});

test("a single leftover item still needs a page", () => {
  assert.equal(pageCount(1, 10), 1);
});

test("zero items need zero pages", () => {
  assert.equal(pageCount(0, 10), 0);
});

test("isLast is true on the true final (partial) page", () => {
  assert.deepEqual(pageInfo(10, 3, 4), { page: 4, pageCount: 4, isLast: true });
});

test("isLast is false before the final page", () => {
  assert.deepEqual(pageInfo(10, 3, 3), { page: 3, pageCount: 4, isLast: false });
});
