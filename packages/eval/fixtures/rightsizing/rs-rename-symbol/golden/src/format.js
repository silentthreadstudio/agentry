// GOLDEN overlay — `fmt` renamed to `formatCurrency`, behavior identical. seed+golden PASSES the oracle.
function formatCurrency(n) {
  return "$" + (Math.round(n * 100) / 100).toFixed(2);
}

module.exports = { formatCurrency };
