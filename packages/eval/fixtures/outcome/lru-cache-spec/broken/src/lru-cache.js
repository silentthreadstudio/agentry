// BROKEN overlay — the PLAUSIBLE-NAIVE solution: a FIFO cache. It honours capacity and stores/reads values, but
// it evicts by INSERTION order (the first key in) and a `get` does NOT refresh recency. So when a key is read and
// then a new key is added at capacity, FIFO wrongly evicts the just-read key instead of the truly-stale one. The
// happy path (store + read under capacity) passes; the refresh-on-get / LRU-eviction TRAP cases fail. The bug is
// the missing recency tracking, not an obvious stub.
class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    // No recency refresh on read — this is the trap.
    return this.map.has(key) ? this.map.get(key) : undefined;
  }

  set(key, value) {
    if (this.map.has(key)) {
      this.map.set(key, value); // overwrite in place (size preserved) — but no recency refresh
      return;
    }
    if (this.map.size >= this.capacity) {
      const firstKey = this.map.keys().next().value; // FIFO: evict the first-inserted, not the LRU
      this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }
}

module.exports = { LRUCache };
