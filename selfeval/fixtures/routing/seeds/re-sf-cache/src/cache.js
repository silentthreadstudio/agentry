'use strict';

// Convention A: a process-local TTL map. Used by the pricing tier lookups.
// Fast, but each web worker has its own copy — entries can't be invalidated
// across processes.
const store = new Map();

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function set(key, value, ttlMs) {
  store.set(key, { value, expires: Date.now() + ttlMs });
}

function del(key) {
  store.delete(key);
}

module.exports = { get, set, del };
