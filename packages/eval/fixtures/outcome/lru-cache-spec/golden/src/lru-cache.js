// GOLDEN overlay — a true LRU cache. A JS Map preserves insertion order, so the FIRST key in iteration order is
// the least-recently-used; every use (get-hit or set) deletes-then-reinserts the key to move it to the most-recent
// end. Eviction removes the first (LRU) key. seed+golden PASSES the held-out oracle.
class LRUCache {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key); // refresh recency: move to the most-recently-used end
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key); // in-place update: refresh recency, do not grow size
    } else if (this.map.size >= this.capacity) {
      const lruKey = this.map.keys().next().value; // first key = least-recently-used
      this.map.delete(lruKey);
    }
    this.map.set(key, value);
  }
}

module.exports = { LRUCache };
