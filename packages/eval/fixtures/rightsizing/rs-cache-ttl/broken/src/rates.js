// BROKEN overlay — the plausible-WRONG resolution of the undecided fork: "cache forever". It memoizes per code
// and NEVER expires, ignoring ttlMs/now — so a stale rate is served indefinitely. This is the exact correctness
// regression the escalation was meant to prevent. seed+broken FAILS the oracle's expiry assertion.
const cache = new Map();

function getRate(code, opts) {
  if (cache.has(code)) {
    return cache.get(code); // BUG: no TTL — serves the first value forever.
  }
  const value = opts.fetch(code);
  cache.set(code, value);
  return value;
}

module.exports = { getRate };
