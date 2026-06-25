// GOLDEN overlay — the four concrete middlewares. Each short-circuits by NOT calling next() on its error path, so the
// rest of the chain (including responder) never runs. seed+golden PASSES.
const { send } = require("./context.js");

function auth() {
  return function authMw(ctx, next) {
    const token = ctx.request.headers && ctx.request.headers.authorization;
    if (!token) {
      send(ctx, 401, "unauthorized");
      return; // short-circuit — do NOT call next()
    }
    ctx.state.user = token; // the authenticated principal
    next();
  };
}

function validate() {
  return function validateMw(ctx, next) {
    if (!ctx.request.body) {
      send(ctx, 400, "bad request");
      return; // short-circuit
    }
    next();
  };
}

function rateLimit(limit) {
  const counts = new Map(); // per-factory-instance counter, keyed by user
  return function rateLimitMw(ctx, next) {
    const key = ctx.state.user;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > limit) {
      send(ctx, 429, "rate limited");
      return; // short-circuit
    }
    next();
  };
}

function responder() {
  return function responderMw(ctx, next) {
    send(ctx, 200, { ok: true, user: ctx.state.user, echo: ctx.request.body });
    next();
  };
}

module.exports = { auth, validate, rateLimit, responder };
