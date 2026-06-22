// BROKEN overlay — the export is renamed to `formatCurrency`...
function formatCurrency(n) {
  return "$" + (Math.round(n * 100) / 100).toFixed(2);
}

module.exports = { formatCurrency };
