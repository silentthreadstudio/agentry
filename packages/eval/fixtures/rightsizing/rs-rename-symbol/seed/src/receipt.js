// Receipt total builder — a second call site of the formatter.
const { fmt } = require("./format.js");

function receiptTotal(n) {
  return "TOTAL " + fmt(n);
}

module.exports = { receiptTotal };
