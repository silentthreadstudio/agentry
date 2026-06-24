// HIDDEN held-out oracle — the subtle-bug probe is the EXACT sum-back: shares must total the original cents, and
// the leftover goes to the earliest shares. The round-each-share broken build loses a cent and FAILS.
const test = require("node:test");
const assert = require("node:assert/strict");

const { splitAmount } = require("../src/money.js");

test("an evenly divisible amount splits into equal shares", () => {
  assert.deepEqual(splitAmount(900, 3), [300, 300, 300]);
});

test("the subtle-bug probe: an indivisible amount still sums back EXACTLY to the total", () => {
  const shares = splitAmount(1000, 3);
  assert.equal(shares.reduce((a, b) => a + b, 0), 1000, "shares must sum to the original total — no cent lost");
});

test("leftover cents go to the EARLIEST shares (earlier shares are one cent larger)", () => {
  assert.deepEqual(splitAmount(1000, 3), [334, 333, 333]);
  assert.deepEqual(splitAmount(1001, 3), [334, 334, 333]);
});

test("splitting into one share returns the whole amount", () => {
  assert.deepEqual(splitAmount(777, 1), [777]);
});
