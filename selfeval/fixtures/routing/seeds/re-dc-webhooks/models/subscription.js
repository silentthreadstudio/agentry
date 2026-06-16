// Subscription model: an in-memory store of webhook endpoints a tenant has registered. This is the
// existing domain. The new feature's subscription model sits here — a row needs a targetUrl, the
// event types it cares about, and a secret for signing.

const subscriptions = new Map();

export function createSubscription({ id, tenantId, targetUrl }) {
  const sub = { id, tenantId, targetUrl, createdAt: Date.now() };
  subscriptions.set(id, sub);
  return sub;
}

export function getSubscription(id) {
  return subscriptions.get(id);
}

export function allSubscriptions() {
  return [...subscriptions.values()];
}
