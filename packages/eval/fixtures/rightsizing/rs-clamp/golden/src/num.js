// GOLDEN overlay — adds the correct `clamp`, leaves `toFixed2` intact. seed+golden PASSES the oracle.
function toFixed2(n) {
  return Math.round(n * 100) / 100;
}

function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

module.exports = { toFixed2, clamp };
