// HIDDEN held-out oracle — fixes the business-day resolution and probes the subtle cross-weekend undercount. The
// add-n-calendar-days broken build lands a business day short whenever the span crosses a weekend, and wrongly
// advances n=0 off a weekend. All dates are UTC, so these expectations are machine-independent.
const test = require("node:test");
const assert = require("node:assert/strict");

const { addBusinessDays } = require("../src/dates.js");

test("adds a business day within the work week", () => {
  // 2024-01-01 is a Monday.
  assert.equal(addBusinessDays("2024-01-01", 1), "2024-01-02");
});

test("a Friday + 1 business day lands on the following Monday", () => {
  // 2024-01-05 is a Friday; the weekend is skipped.
  assert.equal(addBusinessDays("2024-01-05", 1), "2024-01-08");
});

test("the subtle-bug probe: a span crossing a weekend does not undercount", () => {
  // Friday 2024-01-05 + 3 business days = Wed 2024-01-10 (Mon, Tue, Wed) — NOT Mon 01-08.
  assert.equal(addBusinessDays("2024-01-05", 3), "2024-01-10");
});

test("n=0 is a no-op even when the start is a weekend (the fork)", () => {
  // 2024-01-06 is a Saturday; adding zero business days must leave it unchanged.
  assert.equal(addBusinessDays("2024-01-06", 0), "2024-01-06");
});

test("a longer span counts only weekdays", () => {
  // Monday 2024-01-01 + 10 business days = Monday 2024-01-15 (two full work weeks).
  assert.equal(addBusinessDays("2024-01-01", 10), "2024-01-15");
});
