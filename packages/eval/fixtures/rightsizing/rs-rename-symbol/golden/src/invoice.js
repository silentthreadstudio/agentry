// GOLDEN overlay — call site updated to the new name.
const { formatCurrency } = require("./format.js");

function invoiceLine(label, n) {
  return label + ": " + formatCurrency(n);
}

module.exports = { invoiceLine };
