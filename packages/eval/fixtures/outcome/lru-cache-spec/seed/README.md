# lru-cache

A tiny CommonJS module exposing an `LRUCache` class — a fixed-capacity cache with least-recently-used eviction.

`src/lru-cache.js` ships a stub that throws; implement it so the cache evicts by RECENCY, not insertion order:

- `new LRUCache(capacity)` — `capacity` is a positive integer; the cache holds at most that many entries.
- `get(key)` — returns the stored value, or `undefined` if absent. A hit refreshes the key's recency.
- `set(key, value)` — stores the value. A `set` refreshes the key's recency. When storing a new key would
  exceed `capacity`, the LEAST-RECENTLY-USED entry is evicted first.
- Updating an existing key does NOT grow the size (it overwrites and refreshes recency).

No dependencies; keep the CommonJS export (`module.exports = { LRUCache }`).
