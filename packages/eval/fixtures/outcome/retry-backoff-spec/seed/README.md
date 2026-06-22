# retry

A tiny CommonJS module exposing `retry(fn, opts)` — retry an async `fn` with capped exponential backoff.

`src/retry.js` ships a stub that throws; implement it so the error semantics hold:

- a NON-retryable error (`isRetryable(err) === false`) is thrown IMMEDIATELY, with no retry
- after `attempts` total calls it throws the LAST error UNCHANGED (the same error object, not a wrapper)
- it returns `fn`'s value on the first success

`opts.sleep(ms)` is injectable (default: a real delay) so tests can run with no real timers. Backoff is
`min(maxMs, baseMs * 2**(attempt-1))` (defaults `baseMs=10`, `maxMs=1000`). No dependencies; keep the CommonJS
export (`module.exports = { retry }`).
