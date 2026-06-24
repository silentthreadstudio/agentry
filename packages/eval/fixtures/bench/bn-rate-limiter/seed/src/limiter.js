// Per-key rate limiter. `createLimiter` is to be ADDED (see README). The window semantics are the load-bearing
// decision: "within the trailing windowMs" means a SLIDING window, not a fixed reset.
function createLimiter(opts) {
  throw new Error("not implemented");
}

module.exports = { createLimiter };
