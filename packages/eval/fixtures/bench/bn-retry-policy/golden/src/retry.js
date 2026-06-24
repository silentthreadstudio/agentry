// GOLDEN overlay — retries ONLY `retriable` errors; a non-retriable error rethrows immediately (no retry consumed).
// seed+golden PASSES the oracle.
function withRetry(fn, opts) {
  const { retries } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!err || !err.retriable) throw err; // non-retriable → fail fast
      lastErr = err;
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
