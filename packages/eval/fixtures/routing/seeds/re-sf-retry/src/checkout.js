'use strict';

const { chargeCard } = require('./payments');
const { idempotencyKeyFor } = require('./idempotency');

// Checkout calls chargeCard exactly once. Each order already carries a stable id,
// and idempotencyKeyFor(order) derives a deterministic key from it — the same order
// always yields the same key. This is what a safe retry would replay through the
// gateway, but chargeCard does not thread the key down today.
async function placeOrder(order) {
  const key = idempotencyKeyFor(order); // currently unused by chargeCard
  const charge = await chargeCard(order);
  return { orderId: order.id, charge };
}

module.exports = { placeOrder };
