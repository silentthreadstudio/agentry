// GOLDEN overlay — a TTL-aware per-code cache: serve while younger than ttlMs, recompute once older.
// seed+golden PASSES the oracle.
const cache = new Map();

function getRate(code, opts) {
  const now = opts.now();
  const hit = cache.get(code);
  if (hit && now - hit.at < opts.ttlMs) {
    return hit.value;
  }
  const value = opts.fetch(code);
  cache.set(code, { value, at: now });
  return value;
}

module.exports = { getRate };
