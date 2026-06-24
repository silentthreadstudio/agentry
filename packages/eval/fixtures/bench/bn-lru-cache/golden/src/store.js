// GOLDEN overlay — insertion-ordered store over a Map. `set` on an existing key re-inserts (delete first) so
// `keys()` reflects most-recent-at-the-back. seed+golden PASSES the oracle.
function createStore() {
  const map = new Map();
  return {
    has(k) {
      return map.has(k);
    },
    get(k) {
      return map.get(k);
    },
    set(k, v) {
      if (map.has(k)) map.delete(k); // re-insert so the key moves to the back (most recent)
      map.set(k, v);
    },
    delete(k) {
      map.delete(k);
    },
    keys() {
      return [...map.keys()];
    },
  };
}

module.exports = { createStore };
