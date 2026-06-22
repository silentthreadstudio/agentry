// BROKEN overlay — a plausible-but-WRONG "fix": it adds 32 BEFORE scaling instead of after, so the offset is
// also scaled. celsiusToF(0) now yields 32*9/5 = 57.6, not 32 — seed+broken FAILS the oracle.
function celsiusToF(c) {
  return ((c + 32) * 9) / 5; // BUG: offset applied before the scale.
}

module.exports = { celsiusToF };
