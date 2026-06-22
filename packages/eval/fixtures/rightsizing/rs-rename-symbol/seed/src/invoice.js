// Invoice line builder — a call site of the formatter.
const { fmt } = require("./format.js");

function invoiceLine(label, n) {
  return label + ": " + fmt(n);
}

module.exports = { invoiceLine };
