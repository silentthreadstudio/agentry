// BROKEN overlay — the plausible-WRONG reading: a FIXED window that resets the per-key counter every `windowMs`
// bucket. It lets a burst of up to 2×limit through across a bucket boundary (limit hits at the end of one bucket,
// limit more at the start of the next). seed+broken FAILS the oracle's sliding-window boundary-burst probe.
function createLimiter(opts) {
  const { limit, windowMs, now } = opts;
  const buckets = new Map(); // key -> { bucket, count }

  return {
    allow(key) {
      const t = now();
      const bucket = Math.floor(t / windowMs); // BUG: fixed bucket — resets each interval, allows a 2×limit boundary burst.
      const state = buckets.get(key);
      if (!state || state.bucket !== bucket) {
        buckets.set(key, { bucket, count: 1 });
        return true;
      }
      if (state.count >= limit) return false;
      state.count += 1;
      return true;
    },
  };
}

module.exports = { createLimiter };
