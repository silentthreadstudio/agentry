// GOLDEN overlay — sum in integer thousandths (mills) so there is NO float drift, then round the TOTAL half-up
// to cents. seed+golden PASSES the held-out oracle (the discrimination control).
function sumPrices(prices) {
  let mills = 0;
  for (const price of prices) {
    // Inputs are <=3 decimal places, so `price * 1000` lands on an integer once rounded — exact in integer space.
    mills += Math.round(Number(price) * 1000);
  }
  // Round the accumulated thousandths to whole cents, HALF-UP (away from zero on a .5 tie in the tenths place).
  const cents = Math.trunc(mills / 10) + (Math.abs(mills % 10) >= 5 ? Math.sign(mills) : 0);
  return cents / 100;
}

module.exports = { sumPrices };
