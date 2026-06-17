// Order model: an in-memory store of the domain's existing aggregate. The cart model would sit
// alongside it (a cart holds line items keyed by productId, with quantities), following this shape.

const orders = new Map();

export function createOrder({ id, customerId, lines }) {
  const order = { id, customerId, lines, createdAt: Date.now() };
  orders.set(id, order);
  return order;
}

export function getOrder(id) {
  return orders.get(id);
}

export function allOrders() {
  return [...orders.values()];
}
