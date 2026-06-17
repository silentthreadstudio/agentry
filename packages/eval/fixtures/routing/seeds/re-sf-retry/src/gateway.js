'use strict';

// Thin wrapper over the upstream payment processor. Two contract details matter
// for anyone adding retries on top of this:
//
//   - charge() accepts an optional `idempotencyKey`. When the SAME key is replayed,
//     the processor returns the ORIGINAL charge instead of creating a new one. This is
//     the ONLY safe way to retry a charge whose response was lost. Without a key, a
//     retry is a brand-new charge.
//
//   - On failure it throws GatewayError with `.retryable`. Transient faults
//     (timeouts, 502/503, connection resets) set retryable=true; terminal outcomes
//     (card_declined, insufficient_funds, invalid_card) set retryable=false.
class GatewayError extends Error {
  constructor(message, { retryable, code } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.retryable = Boolean(retryable);
    this.code = code;
  }
}

const gateway = {
  // params: { amountCents, currency, source, idempotencyKey? }
  async charge(params) {
    // Real implementation does an HTTP POST to the processor. Elided for the fixture.
    // Behavior contract: replaying the same idempotencyKey returns the original charge;
    // transient faults throw GatewayError({ retryable: true }).
    throw new Error('not implemented in fixture');
  },
};

module.exports = { gateway, GatewayError };
