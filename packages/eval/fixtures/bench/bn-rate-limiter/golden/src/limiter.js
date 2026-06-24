// GOLDEN overlay — SLIDING window: keep each key's allow timestamps, drop those older than `now - windowMs`, and
// admit only while fewer than `limit` remain in the trailing window. seed+golden PASSES the oracle (incl. the
// boundary-burst probe).
function createLimiter(opts) {
  const { limit, windowMs, now } = opts;
  const hits = new Map(); // key -> sorted array of allow timestamps

  return {
    allow(key) {
      const t = now();
      const cutoff = t - windowMs;
      const recent = (hits.get(key) ?? []).filter((ts) => ts > cutoff);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
  };
}

module.exports = { createLimiter };
