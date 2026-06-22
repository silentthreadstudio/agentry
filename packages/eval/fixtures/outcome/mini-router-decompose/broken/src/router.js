// BROKEN overlay — router.js: the PLAUSIBLE-NAIVE resolver. It returns the FIRST registered route whose regex
// matches, with NO static-over-dynamic precedence. So if a dynamic route like "/users/:id" is registered before a
// static "/users/me", a request for "/users/me" wrongly resolves to the dynamic route. Combined with the
// trailing-slash-blind matcher, the simple happy path works but the precedence + trailing-slash TRAP cases fail.
const { matches } = require("./match.js");
const { extractParams } = require("./params.js");

function createRouter() {
  const routes = [];

  function register(pattern, handler) {
    routes.push({ pattern, handler });
  }

  function resolve(path) {
    for (const route of routes) {
      if (matches(route.pattern, path)) {
        // First match wins regardless of static-vs-dynamic — the precedence trap.
        return { handler: route.handler, params: extractParams(route.pattern, path) };
      }
    }
    return { status: 404 };
  }

  return { register, resolve };
}

module.exports = { createRouter };
