// GOLDEN overlay — guards the empty case (returns 0, not NaN). seed+golden PASSES the oracle.
function average(xs) {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

module.exports = { average };
