// BROKEN overlay — the PLAUSIBLE-NAIVE solution: loop up to `attempts`, sleep between tries, and on total
// failure throw a fresh generic error. The retry-then-succeed happy path passes, but it (1) retries a
// NON-retryable error instead of throwing it at once, and (2) SWALLOWS the original error's type/identity,
// surfacing `Error("all attempts failed")` instead of the LAST real error. seed+broken FAILS the oracle on the
// two error-semantics TRAP cases. The bug is the ignored `isRetryable` + the wrapped error, not an obvious stub.
async function retry(fn, opts) {
  const attempts = opts.attempts;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      await sleep(10);
    }
  }
  throw new Error("all attempts failed");
}

module.exports = { retry };
