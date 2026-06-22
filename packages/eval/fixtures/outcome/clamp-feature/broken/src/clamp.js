// BROKEN overlay — a planted-WRONG clamp. seed+broken FAILS the held-out oracle (the discrimination control).
// The bug: the out-of-range branches are SWAPPED — below-range returns `hi` and above-range returns `lo`. So
// clamp(-3, 0, 10) returns 10 (should be 0) and clamp(42, 0, 10) returns 0 (should be 10).
function clamp(n, lo, hi) {
  if (n < lo) return hi;
  if (n > hi) return lo;
  return n;
}

module.exports = { clamp };
