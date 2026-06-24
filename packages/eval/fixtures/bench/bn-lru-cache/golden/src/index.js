// GOLDEN overlay — the LRU: `get` refreshes recency on a hit (re-set moves the key to the back); `set` marks the
// key most-recently-used and evicts the front (least recently used) when a NEW key would exceed capacity.
// seed+golden PASSES the oracle's recency probe.
const { createStore } = require("./store.js");
const { lruVictim } = require("./policy.js");

function createLRU(capacity) {
  const store = createStore();
  return {
    get(k) {
      if (!store.has(k)) return undefined;
      const v = store.get(k);
      store.set(k, v); // a read counts as a use — refresh recency
      return v;
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
