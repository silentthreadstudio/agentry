// GOLDEN overlay — report.js rewired to the shared helper (drifted local copy removed).
const { formatMoney } = require("./format-money.js");

function renderReport(cents) {
  return `Revenue: ${formatMoney(cents)}`;
}

module.exports = { renderReport };
