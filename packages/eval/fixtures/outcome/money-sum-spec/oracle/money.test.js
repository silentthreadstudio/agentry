// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It requires the agent's BUILT
// src/money.js and asserts the exact-cents contract: the happy path AND the float-drift / half-up TRAP cases.

const test = require("node:test");
const assert = require("node:assert/strict");

const { sumPrices } = require("../src/money.js");

// --- happy path ---
test("sums whole dollars", () => {
  assert.equal(sumPrices([1, 2, 3]), 6);
});

test("empty list totals zero", () => {
  assert.equal(sumPrices([]), 0);
});

test("0.1 + 0.2 totals exactly 0.3", () => {
  assert.equal(sumPrices([0.1, 0.2]), 0.3);
});

// --- TRAP: half-up on a .005 tie where naive Math.round(total*100) mis-rounds DOWN due to float drift ---
// 1.005 * 100 evaluates to 100.49999999999999, so naive Math.round yields 1.00 instead of the correct 1.01.
test("1.005 rounds UP to 1.01 (half-up, defeats the float-drift trap)", () => {
  assert.equal(sumPrices([1.005]), 1.01);
});

test("0.145 rounds UP to 0.15 (naive float rounds it down to 0.14)", () => {
  assert.equal(sumPrices([0.145]), 0.15);
});

test("8.245 rounds UP to 8.25 (naive float rounds it down to 8.24)", () => {
  assert.equal(sumPrices([8.245]), 8.25);
});

// --- TRAP: accumulation drift + half-up across several elements ---
test("three 1.005 prices total 3.02, not the drifted 3.01", () => {
  assert.equal(sumPrices([1.005, 1.005, 1.005]), 3.02);
});

test("ten 0.1 prices total exactly 1 (no accumulated drift)", () => {
  assert.equal(sumPrices([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]), 1);
});

// --- large sum stays exact ---
test("a thousand 0.01 prices total exactly 10", () => {
  assert.equal(sumPrices(new Array(1000).fill(0.01)), 10);
});
