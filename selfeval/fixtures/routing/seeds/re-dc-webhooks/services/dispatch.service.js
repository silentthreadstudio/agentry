// Dispatch service: business logic that, given a domain event, looks up the subscriptions that want
// it and hands each one to delivery. Mirrors how other services wrap a model and fan work out. The
// new dispatch logic (match event -> subscriptions -> enqueue a delivery attempt) lives here.

import { allSubscriptions } from "../models/subscription.js";

export function subscriptionsForEvent(eventType) {
  return allSubscriptions().filter((s) => s.tenantId != null);
}

export function dispatchEvent(event) {
  const targets = subscriptionsForEvent(event.type);
  return targets.map((sub) => ({ subscriptionId: sub.id, event }));
}
