// HIDDEN held-out oracle — the discriminator is the short-circuit + ordering seam: an unauthenticated request must be
// stopped by auth and NEVER reach validate/rateLimit/responder, and the short-circuited 401 must survive (responder must
// not overwrite it). The broken build, whose compose ignores short-circuits, lets responder run and overwrite the 401 —
// failing these probes — while still passing the happy path. seed-only throws "not implemented" and fails everything.
const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../src/index.js");
const { auth, validate, rateLimit, responder } = require("../src/middlewares.js");
const { compose } = require("../src/compose.js");
const { createContext, send } = require("../src/context.js");
const { errorResponse } = require("../src/errors.js");

// The required full-app order: auth → rateLimit → validate → responder.
function app(limit = 100) {
  return createApp([auth(), rateLimit(limit), validate(), responder()]);
}

const GOOD = { headers: { authorization: "tok-1" }, body: { hello: "world" } };

test("happy path: an authenticated, valid request reaches the responder (200)", () => {
  const res = app().handle(GOOD);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, user: "tok-1", echo: { hello: "world" } });
});

test("an unauthenticated request short-circuits with 401 (responder never overwrites it)", () => {
  const res = app().handle({ headers: {}, body: { hello: "world" } });
  assert.equal(res.status, 401, "auth must short-circuit and the 401 must survive the chain");
  assert.equal(res.body, "unauthorized");
});

test("an unauthenticated request NEVER reaches validate / rateLimit / responder", () => {
  const reached = [];
  const tap = (name) => (ctx, next) => {
    reached.push(name);
    next();
  };
  // auth first; the tap stand-ins for the downstream stages must never run when auth short-circuits.
  const a = createApp([auth(), tap("rateLimit"), tap("validate"), tap("responder")]);
  const res = a.handle({ headers: {}, body: { hello: "world" } });
  assert.equal(res.status, 401);
  assert.deepEqual(reached, [], "no downstream middleware may run after auth short-circuits");
});

test("a short-circuit halts the chain: nothing after the short-circuiting middleware runs", () => {
  const after = [];
  const stop = (ctx, next) => {
    send(ctx, 418, "teapot");
    // short-circuit: deliberately does NOT call next()
  };
  const trailing = (ctx, next) => {
    after.push("ran");
    send(ctx, 200, "overwritten");
    next();
  };
  const run = compose([stop, trailing]);
  const ctx = createContext({ headers: {}, body: null });
  run(ctx);
  assert.deepEqual(after, [], "a middleware that does not call next() must halt the chain");
  assert.equal(ctx.response.status, 418, "the short-circuited response must survive");
});

test("auth runs BEFORE validate: a missing body on an UNAUTH request yields 401, not 400", () => {
  // If validate ran before auth, an unauthenticated request with no body would leak a 400 (info about validation).
  // Correct order means auth fires first → 401.
  const res = app().handle({ headers: {}, body: null });
  assert.equal(res.status, 401, "auth must guard before validate; unauth wins over invalid");
});

test("validate short-circuits with 400 when an authenticated request has no body", () => {
  const res = app().handle({ headers: { authorization: "tok-1" }, body: null });
  assert.equal(res.status, 400);
  assert.equal(res.body, "bad request");
});

test("rateLimit short-circuits with 429 once the per-user limit is exceeded", () => {
  const a = app(2); // allow 2, the 3rd is limited
  assert.equal(a.handle(GOOD).status, 200);
  assert.equal(a.handle(GOOD).status, 200);
  const res = a.handle(GOOD);
  assert.equal(res.status, 429, "the 3rd request for the same user exceeds limit=2");
  assert.equal(res.body, "rate limited");
});

test("compose: next() may be called at most once per middleware", () => {
  const doubleNext = (ctx, next) => {
    next();
    next(); // illegal
  };
  const run = compose([doubleNext, (ctx, next) => next()]);
  assert.throws(() => run(createContext({})), /multiple times/);
});

test("compose runs middlewares in the given order", () => {
  const order = [];
  const mk = (name) => (ctx, next) => {
    order.push(name);
    next();
  };
  compose([mk("one"), mk("two"), mk("three")])(createContext({}));
  assert.deepEqual(order, ["one", "two", "three"]);
});

test("errorResponse maps a status-bearing error, defaulting to 500", () => {
  const e = new Error("nope");
  e.status = 403;
  assert.deepEqual(errorResponse(e), { status: 403, body: "nope" });
  assert.deepEqual(errorResponse(new Error("boom")), { status: 500, body: "internal error" });
});

test("createApp maps a thrown middleware error via errorResponse", () => {
  const boom = () => {
    const e = new Error("kaboom");
    e.status = 503;
    throw e;
  };
  const a = createApp([boom]);
  assert.deepEqual(a.handle({}), { status: 503, body: "kaboom" });
});
