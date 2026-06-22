// GOLDEN overlay — the correct formula. seed+golden PASSES the oracle.
function celsiusToF(c) {
  return (c * 9) / 5 + 32;
}

module.exports = { celsiusToF };
