// GOLDEN overlay — second call site updated to the new name.
const { formatCurrency } = require("./format.js");

function receiptTotal(n) {
  return "TOTAL " + formatCurrency(n);
}

module.exports = { receiptTotal };
