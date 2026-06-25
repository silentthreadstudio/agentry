// BROKEN overlay — the four middlewares are correct (the bug lives in compose, at the ordering/short-circuit seam).
const { send } = require("./context.js");

function auth() {
  return function authMw(ctx, next) {
    const token = ctx.request.headers && ctx.request.headers.authorization;
    if (!token) {
      send(ctx, 401, "unauthorized");
      return;
    }
    ctx.state.user = token;
    next();
  };
}

function validate() {
  return function validateMw(ctx, next) {
    if (!ctx.request.body) {
      send(ctx, 400, "bad request");
      return;
    }
    next();
  };
}

function rateLimit(limit) {
  const counts = new Map();
  return function rateLimitMw(ctx, next) {
    const key = ctx.state.user;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > limit) {
      send(ctx, 429, "rate limited");
      return;
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
