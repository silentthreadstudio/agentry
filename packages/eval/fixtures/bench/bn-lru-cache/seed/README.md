# lru-cache

An LRU cache across three files with clean seams:
- `src/store.js` — `createStore()` → `{ has, get, set, delete, keys }`, insertion-ordered (`keys()` in insertion order).
- `src/policy.js` — PURE `lruVictim(orderedKeys)` → the key to evict (FRONT of the recency order).
- `src/index.js` — `createLRU(capacity)` → `{ get, set, size }`. `get` refreshes recency on a hit; `set`
  inserts/updates as most-recently-used and evicts the least-recently-used when a NEW key would exceed capacity.

The seed ships stub signatures; fill them in. Keep CommonJS exports. No dependencies.
