'use strict';

// Deterministic idempotency key for an order: same order id -> same key, forever.
// This already exists so that a retried charge can be deduplicated by the gateway.
// It is the intended input to gateway.charge({ idempotencyKey }).
function idempotencyKeyFor(order) {
  return `charge:${order.id}`;
}

module.exports = { idempotencyKeyFor };
