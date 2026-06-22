// BROKEN overlay (part 2/3) — a planted-WRONG report. seed+broken FAILS the held-out oracle.
// The bug: it uses `<=` (at-or-below) instead of `<` (strictly below), so a sku sitting exactly at the threshold
// is wrongly reported as low stock — failing the "strictly below" assertions.
function lowStock(store, threshold) {
  return store
    .skus()
    .filter((sku) => store.quantity(sku) <= threshold)
    .sort();
}

module.exports = { lowStock };
