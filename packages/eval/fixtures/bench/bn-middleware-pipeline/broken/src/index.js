// BROKEN overlay — createApp is correct (the bug lives in compose, at the ordering/short-circuit seam): because
// compose ignores short-circuits, responder always runs and overwrites an early 401/400/429. seed+broken FAILS.
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
