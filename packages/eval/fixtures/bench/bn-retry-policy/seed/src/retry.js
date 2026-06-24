// Retry wrapper. `withRetry` is to be ADDED (see README). The load-bearing decision: only `retriable` errors retry;
// a non-retriable error rethrows immediately.
function withRetry(fn, opts) {
  throw new Error("not implemented");
}

module.exports = { withRetry };
