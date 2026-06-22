// report.js — renders a report line. Carries its OWN copy of formatMoney, which has DRIFTED: it builds the value
// from a float divide and toFixed, which both loses the comma separators AND can mis-pad (e.g. 5 -> "$0.05" is
// fine but 123456 -> "$1234.56"); the canonical helper uses integer math + commas. The refactor must replace it.
function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`; // DRIFT: float divide, no thousands separators
}

function renderReport(cents) {
  return `Revenue: ${formatMoney(cents)}`;
}

module.exports = { renderReport };
