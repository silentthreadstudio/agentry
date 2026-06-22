// HIDDEN held-out oracle — the agent NEVER sees this (oracle/, injected post-run). It drives the BUILT router
// through src/router.js (which must coordinate src/match.js + src/params.js) and asserts the routing contract: a
// basic match + param extraction (happy path) AND the static-over-dynamic precedence, trailing-slash, and 404
// TRAP cases that only a segment-wise, precedence-aware router satisfies.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRouter } = require("../src/router.js");

// --- happy path: a dynamic route matches and its param is extracted ---
test("matches a dynamic route and extracts the param", () => {
  const r = createRouter();
  r.register("/users/:id", "usersHandler");
  const hit = r.resolve("/users/42");
  assert.equal(hit.handler, "usersHandler");
  assert.deepEqual(hit.params, { id: "42" });
});

test("extracts multiple params in order", () => {
  const r = createRouter();
  r.register("/users/:uid/posts/:pid", "postHandler");
  const hit = r.resolve("/users/7/posts/99");
  assert.equal(hit.handler, "postHandler");
  assert.deepEqual(hit.params, { uid: "7", pid: "99" });
});

// --- TRAP: no route matches -> 404 ---
test("returns 404 when no route matches", () => {
  const r = createRouter();
  r.register("/users/:id", "usersHandler");
  const hit = r.resolve("/widgets/1");
  assert.equal(hit.status, 404);
  assert.equal(hit.handler, undefined);
});

// --- TRAP: a STATIC route beats a DYNAMIC one for the same path, even when the dynamic is registered first ---
test("a static route takes precedence over a dynamic route for the same path", () => {
  const r = createRouter();
  r.register("/users/:id", "dynamicHandler"); // registered FIRST
  r.register("/users/me", "staticHandler"); // static, registered SECOND
  const hit = r.resolve("/users/me");
  assert.equal(hit.handler, "staticHandler"); // static must win despite later registration
  assert.deepEqual(hit.params, {});
});

// --- TRAP: a trailing slash on the path is ignored ---
test("ignores a trailing slash on the resolved path", () => {
  const r = createRouter();
  r.register("/users/:id", "usersHandler");
  const hit = r.resolve("/users/42/");
  assert.equal(hit.handler, "usersHandler");
  assert.deepEqual(hit.params, { id: "42" });
});

// --- among equal (both dynamic) matches, the first registered wins ---
test("first registered wins among equal dynamic matches", () => {
  const r = createRouter();
  r.register("/:a/:b", "first");
  r.register("/:x/:y", "second");
  const hit = r.resolve("/p/q");
  assert.equal(hit.handler, "first");
});
