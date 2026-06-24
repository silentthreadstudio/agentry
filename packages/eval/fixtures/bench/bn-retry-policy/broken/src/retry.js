// BROKEN overlay — the plausible-WRONG reading: retry EVERY thrown error up to `retries`, ignoring the `retriable`
// flag. A non-retriable client error is retried (wasting attempts and risking a duplicated side effect) instead of
// failing fast. seed+broken FAILS the oracle's non-retriable probe (it retries when it must not).
function withRetry(fn, opts) {
  const { retries } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err; // BUG: ignores `err.retriable` — retries non-retriable errors instead of rethrowing at once.
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
