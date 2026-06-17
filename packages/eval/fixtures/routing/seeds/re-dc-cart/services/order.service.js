// Order service: business logic over the order model. The pricing service would mirror this layer —
// taking a cart's line items, reading the catalog, and returning a priced total (subtotal per line,
// summed) without touching transport or storage. A checkout flow composes pricing + reservation here.

import { createOrder, getOrder, allOrders } from "../models/order.js";

export function placeOrder(input) {
  return createOrder(input);
}

export function findOrder(id) {
  return getOrder(id);
}

export function listOrders() {
  return allOrders();
}
