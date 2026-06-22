// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It drives all three modules'
// public render functions and asserts each formats money CANONICALLY ($, comma thousands, two decimals) and that
// the three agree on the same amount. The drifted seed FAILS (receipt drops commas, report uses a float divide);
// a refactor that leaves even one caller on its old drifted copy also FAILS (the consistency check catches it).

const test = require("node:test");
const assert = require("node:assert/strict");

const { renderInvoice } = require("../src/invoice.js");
const { renderReceipt } = require("../src/receipt.js");
const { renderReport } = require("../src/report.js");

// Pull the money substring out of each module's wrapper text so we assert on the formatting itself.
const moneyOf = (s) => s.match(/\$[\d,]+\.\d{2}/)?.[0];

// --- each module formats money canonically ---
test("invoice renders canonical money", () => {
  assert.equal(renderInvoice(123456), "Invoice total: $1,234.56");
  assert.equal(renderInvoice(5), "Invoice total: $0.05");
  assert.equal(renderInvoice(0), "Invoice total: $0.00");
});

test("receipt renders canonical money (thousands separators required)", () => {
  assert.equal(renderReceipt(123456), "Paid $1,234.56");
  assert.equal(renderReceipt(100000000), "Paid $1,000,000.00");
});

test("report renders canonical money (no stale drifted copy)", () => {
  assert.equal(renderReport(123456), "Revenue: $1,234.56");
  assert.equal(renderReport(5), "Revenue: $0.05");
});

// --- TRAP: all three modules must format the SAME amount IDENTICALLY (the dedup consistency) ---
test("all three modules format the same amount identically", () => {
  for (const cents of [0, 5, 99, 100, 123456, 100000000]) {
    const a = moneyOf(renderInvoice(cents));
    const b = moneyOf(renderReceipt(cents));
    const c = moneyOf(renderReport(cents));
    assert.ok(a, `invoice produced no money string for ${cents}`);
    assert.equal(b, a, `receipt disagrees with invoice for ${cents}`);
    assert.equal(c, a, `report disagrees with invoice for ${cents}`);
  }
});

// --- canonical edge: large amount with multiple comma groups ---
test("formats large amounts with multiple thousands groups", () => {
  assert.equal(renderInvoice(100000000), "Invoice total: $1,000,000.00");
});
