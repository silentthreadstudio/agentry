// BROKEN overlay — receipt.js rewired to the shared helper (correct).
const { formatMoney } = require("./format-money.js");

function renderReceipt(cents) {
  return `Paid ${formatMoney(cents)}`;
}

module.exports = { renderReceipt };
