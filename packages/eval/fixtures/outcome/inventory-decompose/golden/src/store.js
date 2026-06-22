// GOLDEN overlay (part 1/3) — a correct store. seed+golden PASSES the held-out oracle.
function createStore() {
  const totals = new Map();
  return {
    add(sku, qty) {
      totals.set(sku, (totals.get(sku) ?? 0) + qty);
    },
    remove(sku, qty) {
      totals.set(sku, Math.max(0, (totals.get(sku) ?? 0) - qty));
    },
    quantity(sku) {
      return totals.get(sku) ?? 0;
    },
    skus() {
      return [...totals.keys()];
    },
  };
}

module.exports = { createStore };
