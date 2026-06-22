# inventory

A tiny CommonJS inventory library, split across three files that must agree on one contract:

- `src/store.js` — `createStore()` → `{ add(sku, qty), remove(sku, qty), quantity(sku), skus() }`. Quantities start
  at 0, never go below 0, an unknown sku reads as 0, and `skus()` lists every sku ever added.
- `src/report.js` — `lowStock(store, threshold)` → the skus (from `store.skus()`) whose quantity is strictly below
  `threshold`, sorted ascending by sku.
- `src/index.js` — re-exports `createStore` and `lowStock`.

All three ship as stubs that throw; implement them so they coordinate. CommonJS exports throughout; no dependencies.
