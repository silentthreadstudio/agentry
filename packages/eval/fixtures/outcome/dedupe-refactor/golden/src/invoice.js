// GOLDEN overlay — invoice.js rewired to the shared helper (local copy removed).
const { formatMoney } = require("./format-money.js");

function renderInvoice(cents) {
  return `Invoice total: ${formatMoney(cents)}`;
}

module.exports = { renderInvoice };
