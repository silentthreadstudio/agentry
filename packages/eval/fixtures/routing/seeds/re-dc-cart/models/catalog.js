// Catalog model: the product table the pricing service reads from. A cart references these by
// productId; pricing multiplies unitPrice by quantity. Stock is what the reservation worker decrements.

const products = new Map([
  ["sku-1", { id: "sku-1", name: "Widget", unitPrice: 250, stock: 12 }],
  ["sku-2", { id: "sku-2", name: "Gadget", unitPrice: 1800, stock: 3 }],
  ["sku-3", { id: "sku-3", name: "Gizmo", unitPrice: 999, stock: 0 }],
]);

export function getProduct(id) {
  return products.get(id);
}

export function decrementStock(id, qty) {
  const p = products.get(id);
  if (!p) return false;
  if (p.stock < qty) return false;
  p.stock -= qty;
  return true;
}
