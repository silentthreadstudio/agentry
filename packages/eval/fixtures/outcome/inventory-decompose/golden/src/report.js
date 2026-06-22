// GOLDEN overlay (part 2/3) — a correct report. seed+golden PASSES the held-out oracle.
function lowStock(store, threshold) {
  return store
    .skus()
    .filter((sku) => store.quantity(sku) < threshold)
    .sort();
}

module.exports = { lowStock };
