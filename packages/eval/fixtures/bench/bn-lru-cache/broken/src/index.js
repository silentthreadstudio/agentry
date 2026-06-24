// BROKEN overlay — `get` does NOT refresh recency, so eviction degrades to FIFO (insertion order). A key that was
// just READ is still treated as oldest and gets wrongly evicted. The cache still stores/returns values and honors
// capacity, so the bug hides until a get-then-evict sequence. seed+broken FAILS the oracle's recency probe.
const { createStore } = require("./store.js");
const { lruVictim } = require("./policy.js");

function createLRU(capacity) {
  const store = createStore();
  return {
    get(k) {
      if (!store.has(k)) return undefined;
      return store.get(k); // BUG: a read does NOT refresh recency — eviction is FIFO, not LRU.
    },
    set(k, v) {
      const isNew = !store.has(k);
      if (isNew && store.keys().length >= capacity) {
        store.delete(lruVictim(store.keys()));
      }
      store.set(k, v);
    },
    size() {
      return store.keys().length;
    },
  };
}

module.exports = { createLRU };
