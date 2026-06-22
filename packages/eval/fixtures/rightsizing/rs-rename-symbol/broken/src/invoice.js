// BROKEN overlay — call site updated correctly here.
const { formatCurrency } = require("./format.js");

function invoiceLine(label, n) {
  return label + ": " + formatCurrency(n);
}

module.exports = { invoiceLine };
