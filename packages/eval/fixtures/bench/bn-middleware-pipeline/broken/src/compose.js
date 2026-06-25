// BROKEN overlay — compose iterates EVERY middleware in order, calling each with a no-op-ish `next`, but it does NOT
// honor the short-circuit: even when a middleware declines to call next(), the loop keeps going and runs the rest of the
// chain anyway. So an auth failure sets 401 — and then responder still runs and overwrites it with 200. The app still
// returns values and looks right on the happy path, so the bug hides until an unauthorized/invalid/rate-limited request.
// seed+broken FAILS the oracle's short-circuit probes.
function compose(middlewares) {
  return function run(ctx) {
    for (let i = 0; i < middlewares.length; i++) {
      // BUG: always advances to the next middleware regardless of whether this one called next().
      // A short-circuit (a middleware NOT calling next) is ignored, so downstream middlewares — including
      // responder — still run and overwrite the short-circuited 401/400/429 response.
      middlewares[i](ctx, function next() {});
    }
    return ctx;
  };
}

module.exports = { compose };
