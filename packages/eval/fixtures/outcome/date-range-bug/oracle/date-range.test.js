// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It requires the agent's FIXED
// src/date-range.js and asserts the inclusive-range contract: a casual happy case AND the inclusive-count,
// same-day, and adjacent-boundary TRAP cases the shipped (buggy) seed fails until fixed. Dates are pinned to UTC
// midnight so the assertions are timezone-stable.

const test = require("node:test");
const assert = require("node:assert/strict");

const { daysBetween, overlaps } = require("../src/date-range.js");

const d = (iso) => new Date(`${iso}T00:00:00.000Z`);

// --- daysBetween: inclusive whole-day count ---
test("daysBetween counts a single day as 1 (same-day TRAP)", () => {
  assert.equal(daysBetween(d("2026-01-01"), d("2026-01-01")), 1);
});

test("daysBetween is inclusive of both ends (off-by-one TRAP)", () => {
  assert.equal(daysBetween(d("2026-01-01"), d("2026-01-03")), 3);
  assert.equal(daysBetween(d("2026-01-01"), d("2026-01-02")), 2);
});

test("daysBetween ignores time-of-day", () => {
  const a = new Date("2026-01-01T23:30:00.000Z");
  const b = new Date("2026-01-02T00:15:00.000Z");
  assert.equal(daysBetween(a, b), 2); // still 2 inclusive calendar days
});

// --- overlaps: inclusive shared-day semantics ---
test("overlaps is true when the ranges share interior days", () => {
  assert.equal(overlaps({ start: d("2026-01-01"), end: d("2026-01-05") }, { start: d("2026-01-03"), end: d("2026-01-09") }), true);
});

test("overlaps is true when the ranges share only a boundary day", () => {
  assert.equal(overlaps({ start: d("2026-01-01"), end: d("2026-01-05") }, { start: d("2026-01-05"), end: d("2026-01-09") }), true);
});

test("overlaps is false for merely-adjacent ranges with no shared day (boundary TRAP)", () => {
  assert.equal(overlaps({ start: d("2026-01-01"), end: d("2026-01-05") }, { start: d("2026-01-06"), end: d("2026-01-09") }), false);
});

test("overlaps is true for two identical single-day ranges", () => {
  assert.equal(overlaps({ start: d("2026-01-01"), end: d("2026-01-01") }, { start: d("2026-01-01"), end: d("2026-01-01") }), true);
});

test("overlaps is false for clearly disjoint ranges", () => {
  assert.equal(overlaps({ start: d("2026-01-01"), end: d("2026-01-02") }, { start: d("2026-02-01"), end: d("2026-02-05") }), false);
});
