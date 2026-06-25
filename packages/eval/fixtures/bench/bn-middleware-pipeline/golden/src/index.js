// GOLDEN overlay — createApp composes the middlewares in the GIVEN order, runs them over a fresh context per request,
// maps any thrown error, and returns ctx.response. The correct full-app order (auth → rateLimit → validate → responder)
// is passed in by the caller; compose's true short-circuit guarantees that an early 401/400/429 halts every later stage,
// so responder never overwrites a short-circuited response. seed+golden PASSES the oracle.
const { createContext } = require("./context.js");
const { compose } = require("./compose.js");
const { errorResponse } = require("./errors.js");

function createApp(middlewareOrder) {
  const run = compose(middlewareOrder);
  return {
    handle(request) {
      const ctx = createContext(request);
      try {
        run(ctx);
      } catch (err) {
        return errorResponse(err);
      }
      return ctx.response;
    },
  };
}

module.exports = { createApp };
