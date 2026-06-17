'use strict';

const { gateway } = require('./gateway');

// chargeCard makes ONE attempt against the gateway. It currently does not retry,
// so a transient network blip or a 503 from the gateway surfaces to the caller as
// a hard failure even though the charge never reached the processor.
//
// Two things make "just retry it" the wrong instinct here:
//   1. The call is NOT idempotent on its own. If the first request actually reached
//      the processor and we only lost the RESPONSE (timeout, dropped socket), a blind
//      retry charges the customer twice. The gateway supports an idempotency key
//      (see gateway.charge below) precisely to make a retry safe — but chargeCard
//      does not pass one today.
//   2. Not every failure is retryable. gateway.charge throws GatewayError with a
//      `.retryable` flag: a 503/timeout is retryable; a `card_declined` is a terminal
//      business outcome and retrying it just burns attempts and may trip fraud rules.
async function chargeCard(order) {
  const result = await gateway.charge({
    amountCents: order.amountCents,
    currency: order.currency,
    source: order.cardToken,
  });
  return { chargeId: result.id, status: result.status };
}

module.exports = { chargeCard };
