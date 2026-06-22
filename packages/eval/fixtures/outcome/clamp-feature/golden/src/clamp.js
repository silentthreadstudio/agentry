// GOLDEN overlay — a known-correct clamp. seed+golden PASSES the held-out oracle (the discrimination control).
function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

module.exports = { clamp };
