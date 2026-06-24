// BROKEN overlay — the OBVIOUS ladder with STRICT `>` boundaries, so an order of EXACTLY 50 or EXACTLY 100 units
// misses its tier (gets the lower discount). seed+broken FAILS the oracle's exact-threshold probe.
function discountFor(qty) {
  if (qty > 100) return 0.2; // BUG: strict > — qty exactly 100 misses the 20% tier.
  if (qty > 50) return 0.1; // BUG: strict > — qty exactly 50 misses the 10% tier.
  if (qty > 10) return 0.05; // BUG: strict > — qty exactly 10 misses the 5% tier.
  return 0;
}

function priceCents(unitCents, qty) {
  const subtotal = unitCents * qty;
  const total = subtotal * (1 - discountFor(qty));
  return Math.round(total);
}

module.exports = { priceCents };
