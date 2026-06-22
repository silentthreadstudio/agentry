// GOLDEN overlay — receipt.js rewired to the shared helper (drifted local copy removed).
const { formatMoney } = require("./format-money.js");

function renderReceipt(cents) {
  return `Paid ${formatMoney(cents)}`;
}

module.exports = { renderReceipt };
