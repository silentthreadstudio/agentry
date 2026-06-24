// BROKEN overlay — the OBVIOUS solution with the subtle bug: sum/length divides by zero on the empty array, so
// `average([])` is NaN (should be 0). seed+broken FAILS the oracle's empty-array case — the escaped defect.
function average(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length; // BUG: NaN when xs is empty (0/0).
}

module.exports = { average };
