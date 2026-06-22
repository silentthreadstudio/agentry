// BROKEN overlay — invoice.js rewired to the shared helper (correct).
const { formatMoney } = require("./format-money.js");

function renderInvoice(cents) {
  return `Invoice total: ${formatMoney(cents)}`;
}

module.exports = { renderInvoice };
