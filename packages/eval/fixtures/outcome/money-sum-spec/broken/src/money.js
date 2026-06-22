// BROKEN overlay — the PLAUSIBLE-NAIVE solution: sum the floats directly, then Math.round to 2 decimals.
// Looks right and passes trivial whole-dollar sums, but accumulates IEEE-754 drift on decimals and mis-rounds
// the .005 half-up tie (Math.round operates on the already-drifted float). seed+broken FAILS the oracle on the
// trap cases. The bug is the float arithmetic, not an obvious stub.
function sumPrices(prices) {
  const total = prices.reduce((a, b) => a + b, 0);
  return Math.round(total * 100) / 100;
}

module.exports = { sumPrices };
