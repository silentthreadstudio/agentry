// BROKEN overlay — the PLAUSIBLE-NAIVE solution: a shallow spread. Copies the top-level keys (so top-level
// reassignment is isolated and value-equality on flat objects passes), but every nested object/array is the SAME
// reference as the original — mutating the clone at depth corrupts the original. seed+broken FAILS the oracle on
// the deep-isolation trap cases. The bug is the shallow copy, not an obvious stub.
function deepClone(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  return { ...obj };
}

module.exports = { deepClone };
