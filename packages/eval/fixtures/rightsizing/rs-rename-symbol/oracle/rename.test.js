// HIDDEN held-out oracle — requires the NEW name `formatCurrency` to be exported and used end-to-end across all
// three modules. The un-renamed seed FAILS (no `formatCurrency` export); an incomplete rename FAILS (a stale call
// site throws); a complete rename PASSES.
const test = require("node:test");
const assert = require("node:assert/strict");

const { formatCurrency } = require("../src/format.js");
const { invoiceLine } = require("../src/invoice.js");
const { receiptTotal } = require("../src/receipt.js");

test("the renamed export exists and formats currency", () => {
  assert.equal(typeof formatCurrency, "function");
  assert.equal(formatCurrency(5), "$5.00");
});

test("the old name is gone", () => {
  const format = require("../src/format.js");
  assert.equal(format.fmt, undefined);
});

test("invoice call site uses the renamed function", () => {
  assert.equal(invoiceLine("Widget", 5), "Widget: $5.00");
});

test("receipt call site uses the renamed function", () => {
  assert.equal(receiptTotal(12.5), "TOTAL $12.50");
});
