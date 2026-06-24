// HIDDEN held-out oracle — probes each tier BOUNDARY at exactly the threshold quantity (the strict-> off-by-one
// bug drops the tier there) plus the whole-order rounding.
const test = require("node:test");
const assert = require("node:assert/strict");

const { priceCents } = require("../src/pricing.js");

test("no discount below the first tier", () => {
  assert.equal(priceCents(100, 5), 500);
});

test("the boundary probe: EXACTLY 10 units gets the 5% tier", () => {
  assert.equal(priceCents(100, 10), 950, "qty 10 is in the >=10 tier (5% off), not full price");
});

test("the boundary probe: EXACTLY 50 units gets the 10% tier", () => {
  assert.equal(priceCents(100, 50), 4500);
});

test("the boundary probe: EXACTLY 100 units gets the 20% tier", () => {
  assert.equal(priceCents(100, 100), 8000);
});

test("the whole-order total is rounded half up to the nearest cent", () => {
  // 101 * 10 = 1010 subtotal, 5% off = 959.5 → 960.
  assert.equal(priceCents(101, 10), 960);
});
