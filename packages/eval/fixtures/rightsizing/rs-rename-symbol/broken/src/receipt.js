// BROKEN overlay — the INCOMPLETE rename: this call site still imports the OLD name `fmt`, which no longer
// exists, so `formatCurrency` was missed here and `fmt` is `undefined`. receiptTotal throws → seed+broken FAILS.
const { fmt } = require("./format.js"); // BUG: stale import of the renamed-away symbol.

function receiptTotal(n) {
  return "TOTAL " + fmt(n);
}

module.exports = { receiptTotal };
