// Currency formatter. The exported name `fmt` is to be RENAMED to `formatCurrency` (see README).
function fmt(n) {
  return "$" + (Math.round(n * 100) / 100).toFixed(2);
}

module.exports = { fmt };
