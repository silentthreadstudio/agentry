// GOLDEN overlay — inclusive tier boundaries (`>=`) and a half-up rounding of the whole-order total. seed+golden
// PASSES the oracle, including the exact-threshold cases.
function discountFor(qty) {
  if (qty >= 100) return 0.2;
  if (qty >= 50) return 0.1;
  if (qty >= 10) return 0.05;
  return 0;
}

function priceCents(unitCents, qty) {
  const subtotal = unitCents * qty;
  const total = subtotal * (1 - discountFor(qty));
  return Math.round(total);
}

module.exports = { priceCents };
