// GOLDEN overlay — respects `isRetryable` (throw a non-retryable error at once), caps the backoff, stops at
// `attempts`, and re-throws the LAST error unchanged. seed+golden PASSES the held-out oracle.
async function retry(fn, opts) {
  const attempts = opts.attempts;
  const isRetryable = opts.isRetryable || (() => true);
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const baseMs = opts.baseMs ?? 10;
  const maxMs = opts.maxMs ?? 1000;

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err; // non-retryable: surface immediately, no retry
      if (attempt === attempts) throw err; // attempt cap reached: throw the LAST error, unchanged
      const delay = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
  throw lastErr; // unreachable for attempts >= 1, but keeps the contract explicit
}

module.exports = { retry };
